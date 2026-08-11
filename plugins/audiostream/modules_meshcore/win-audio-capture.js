'use strict';
/*
 * win-audio-capture.js  (MeshAgent module)
 *
 * IPC strategy: file-based chunks in a per-session temp dir.
 *   PowerShell C# WASAPI loopback -> writes chunk_NNNNNN.raw every 50ms
 *   Agent polls with setInterval, reads each chunk, deletes it, sends via tunnel.
 * This avoids the cross-session stdout-pipe problem entirely.
 */

var obj    = {};
var _active = null;

obj.ontunneldata = function (data, tunnel) {
    var cmd = (typeof data === 'string') ? data.trim() : null;
    if      (cmd === 'start') obj._startCapture(tunnel);
    else if (cmd === 'stop')  obj._stopCapture();
};

obj._startCapture = function (tunnel) {
    if (_active) obj._stopCapture();

    var fs  = require('fs');
    var cp  = require('child_process');
    var env = require('process').env;

    // Per-session temp dir so concurrent sessions don't collide
    var sid    = Math.random().toString(36).substr(2, 8);
    var tmpDir = (env.TEMP || env.tmp || 'C:\\Windows\\Temp') + '\\mc-aud-' + sid;

    try { fs.mkdirSync(tmpDir); } catch (e) {
        try { tunnel.write('ERROR:Cannot create tmp dir: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    var psPath = tmpDir + '\\capture.ps1';
    try {
        fs.writeFileSync(psPath, buildScript(tmpDir), { encoding: 'utf8' });
    } catch (e) {
        try { tunnel.write('ERROR:Cannot write PS script: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    // Spawn PowerShell -- we do NOT read stdout; IPC is via chunk files
    var proc;
    try {
        proc = cp.execFile('powershell.exe', [
            '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath
        ]);
    } catch (e) {
        try { tunnel.write('ERROR:Cannot spawn PowerShell: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    var headerSent = false;
    var chunkIdx   = 0;
    var startTime  = Date.now();
    var lastChunk  = Date.now();

    var pollId = setInterval(function () {
        if (!_active) { clearInterval(pollId); return; }
        var now = Date.now();

        try {
            if (!headerSent) {
                // Timeout: 12s with no header means WASAPI failed
                if (now - startTime > 12000) {
                    tunnel.write('ERROR:No audio device found or Add-Type compile failed');
                    obj._stopCapture();
                    return;
                }
                var hdrPath = tmpDir + '\\header.txt';
                if (!fs.existsSync(hdrPath)) return;
                var hdr = fs.readFileSync(hdrPath).toString().trim();
                if (!hdr) return;
                // header.txt holds either AUDIO:sr:ch:16 or ERROR:...
                tunnel.write(hdr);
                if (hdr.indexOf('ERROR:') === 0) { obj._stopCapture(); return; }
                headerSent = true;
                lastChunk  = now;
                return;
            }

            // Stall guard: no new chunk for 8s after header was sent
            if (now - lastChunk > 8000) {
                tunnel.write('ERROR:Audio stream stalled -- WASAPI may have stopped');
                obj._stopCapture();
                return;
            }

            var chunkPath = tmpDir + '\\chunk_' + pad6(chunkIdx) + '.raw';
            if (!fs.existsSync(chunkPath)) return;

            var data   = fs.readFileSync(chunkPath);
            var aligned = Math.floor(data.length / 4) * 4; // align to int16-stereo boundary
            if (aligned > 0) tunnel.write(data.slice(0, aligned));
            try { fs.unlinkSync(chunkPath); } catch (_) {}
            chunkIdx++;
            lastChunk = now;
        } catch (e) {
            // transient file-not-ready errors are normal -- ignore
        }
    }, 20);

    _active = { proc: proc, tmpDir: tmpDir, pollId: pollId, fs: fs };
};

function pad6 (n) { return ('000000' + n).slice(-6); }

obj._stopCapture = function () {
    if (!_active) return;
    var a  = _active;
    _active = null;
    if (a.pollId) { try { clearInterval(a.pollId); } catch (_) {} }
    // Signal PowerShell to exit cleanly
    try { a.fs.writeFileSync(a.tmpDir + '\\stop.signal', '1'); } catch (_) {}
    // After 2s kill process and delete temp dir
    setTimeout(function () {
        if (a.proc) { try { a.proc.kill(); } catch (_) {} }
        try {
            var files = a.fs.readdirSync(a.tmpDir);
            for (var i = 0; i < files.length; i++) {
                try { a.fs.unlinkSync(a.tmpDir + '\\' + files[i]); } catch (_) {}
            }
            a.fs.rmdirSync(a.tmpDir);
        } catch (_) {}
    }, 2000);
};

// Build the complete PowerShell + inline C# WASAPI loopback script.
// tmpDir is passed in; chunks written as chunk_NNNNNN.raw.tmp then atomically renamed.
function buildScript (tmpDir) {
    // Note: @" ... "@ is PowerShell's verbatim here-string.
    // The closing "@ MUST appear at column 0 in the generated file.
    return '$TmpDir = \'' + tmpDir + '\'\n' +
'\n' +
'$csharp = @\'\n' +
'using System;\n' +
'using System.IO;\n' +
'using System.Runtime.InteropServices;\n' +
'using System.Threading;\n' +
'\n' +
'[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n' +
'public interface IMMDeviceEnumerator {\n' +
'    void EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);\n' +
'    void GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint);\n' +
'    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IntPtr ppDevice);\n' +
'    void RegisterEndpointNotificationCallback(IntPtr pClient);\n' +
'    void UnregisterEndpointNotificationCallback(IntPtr pClient);\n' +
'}\n' +
'\n' +
'[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n' +
'public interface IMMDevice {\n' +
'    void Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int dwClsCtx,\n' +
'        IntPtr pActivationParams, out IntPtr ppInterface);\n' +
'    void OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);\n' +
'    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);\n' +
'    void GetState(out int pdwState);\n' +
'}\n' +
'\n' +
'[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n' +
'public interface IMMDeviceCollection {\n' +
'    void GetCount(out uint pcDevices);\n' +
'    void Item(uint nDevice, out IntPtr ppDevice);\n' +
'}\n' +
'\n' +
'[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n' +
'public interface IAudioClient {\n' +
'    void Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration,\n' +
'        long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);\n' +
'    void GetBufferSize(out uint pNumBufferFrames);\n' +
'    void GetStreamLatency(out long phnsLatency);\n' +
'    void GetCurrentPadding(out uint pNumPaddingFrames);\n' +
'    void IsFormatSupported(int ShareMode, ref WAVEFORMATEX pFormat, out IntPtr ppClosestMatch);\n' +
'    void GetMixFormat(out IntPtr ppDeviceFormat);\n' +
'    void GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);\n' +
'    void Start();\n' +
'    void Stop();\n' +
'    void Reset();\n' +
'    void SetEventHandle(IntPtr eventHandle);\n' +
'    void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);\n' +
'}\n' +
'\n' +
'[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n' +
'public interface IAudioCaptureClient {\n' +
'    void GetBuffer(out IntPtr ppData, out uint pNumFramesAvailable,\n' +
'        out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);\n' +
'    void ReleaseBuffer(uint NumFramesRead);\n' +
'    void GetNextPacketSize(out uint pNumFramesInNextPacket);\n' +
'}\n' +
'\n' +
'[StructLayout(LayoutKind.Sequential)]\n' +
'public struct WAVEFORMATEX {\n' +
'    public ushort wFormatTag, nChannels;\n' +
'    public uint   nSamplesPerSec, nAvgBytesPerSec;\n' +
'    public ushort nBlockAlign, wBitsPerSample, cbSize;\n' +
'}\n' +
'\n' +
'public static class WasapiCapture {\n' +
'    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;\n' +
'    const uint AUDCLNT_BUFFERFLAGS_SILENT   = 0x00000002;\n' +
'    const int  AUDCLNT_SHAREMODE_SHARED     = 0;\n' +
'    const int  CLSCTX_ALL                   = 23;\n' +
'\n' +
'    static readonly Guid IID_IAudioClient        = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");\n' +
'    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");\n' +
'\n' +
'    [DllImport("ole32")] static extern int CoCreateInstance(\n' +
'        [MarshalAs(UnmanagedType.LPStruct)] Guid clsid, IntPtr pUnkOuter,\n' +
'        int dwClsContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);\n' +
'    [DllImport("ole32")] static extern void CoInitialize(IntPtr reserved);\n' +
'\n' +
'    static IMMDevice GetDevice(IMMDeviceEnumerator en) {\n' +
'        IntPtr p;\n' +
'        try {\n' +
'            en.GetDefaultAudioEndpoint(0, 0, out p);\n' +
'            var d = (IMMDevice)Marshal.GetObjectForIUnknown(p); Marshal.Release(p); return d;\n' +
'        } catch {}\n' +
'        en.EnumAudioEndpoints(0, 1, out p);\n' +
'        var col = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(p); Marshal.Release(p);\n' +
'        uint cnt; col.GetCount(out cnt);\n' +
'        if (cnt == 0) throw new Exception("No active audio render endpoints found");\n' +
'        IntPtr dp; col.Item(0, out dp);\n' +
'        var d2 = (IMMDevice)Marshal.GetObjectForIUnknown(dp); Marshal.Release(dp); return d2;\n' +
'    }\n' +
'\n' +
'    public static void Run(string tmpDir) {\n' +
'        CoInitialize(IntPtr.Zero);\n' +
'        var stopPath = Path.Combine(tmpDir, "stop.signal");\n' +
'\n' +
'        var mmEnumClsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");\n' +
'        var mmEnumIid   = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");\n' +
'        IntPtr ep; CoCreateInstance(mmEnumClsid, IntPtr.Zero, CLSCTX_ALL, mmEnumIid, out ep);\n' +
'        var enumerator = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(ep); Marshal.Release(ep);\n' +
'\n' +
'        var device = GetDevice(enumerator);\n' +
'\n' +
'        IntPtr acPtr;\n' +
'        device.Activate(IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out acPtr);\n' +
'        var ac = (IAudioClient)Marshal.GetObjectForIUnknown(acPtr); Marshal.Release(acPtr);\n' +
'\n' +
'        IntPtr fmtPtr; ac.GetMixFormat(out fmtPtr);\n' +
'        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));\n' +
'        Marshal.FreeCoTaskMem(fmtPtr);\n' +
'\n' +
'        bool isFloat = (fmt.wFormatTag == 3);\n' +
'        int  outSR   = (int)fmt.nSamplesPerSec;\n' +
'        int  outCH   = fmt.nChannels;\n' +
'\n' +
'        ac.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,\n' +
'            100 * 10000L, 0, ref fmt, IntPtr.Zero);\n' +
'\n' +
'        IntPtr ccPtr; ac.GetService(IID_IAudioCaptureClient, out ccPtr);\n' +
'        var cc = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(ccPtr); Marshal.Release(ccPtr);\n' +
'\n' +
'        File.WriteAllText(Path.Combine(tmpDir, "header.txt"),\n' +
'            "AUDIO:" + outSR + ":" + outCH + ":16");\n' +
'\n' +
'        ac.Start();\n' +
'\n' +
'        int bytesPerFrame = outCH * 2;\n' +
'        int targetBytes   = outSR * bytesPerFrame / 20;  // 50ms per chunk\n' +
'        var ms = new MemoryStream();\n' +
'        int chunkIdx = 0;\n' +
'        byte[] floatBuf = null;\n' +
'\n' +
'        while (!File.Exists(stopPath)) {\n' +
'            Thread.Sleep(10);\n' +
'            uint pktSize; cc.GetNextPacketSize(out pktSize);\n' +
'            while (pktSize > 0) {\n' +
'                IntPtr data; uint frames, flags; ulong dp, qp;\n' +
'                cc.GetBuffer(out data, out frames, out flags, out dp, out qp);\n' +
'                int outBytes = (int)frames * bytesPerFrame;\n' +
'                if (outBytes > 0) {\n' +
'                    var buf = new byte[outBytes];\n' +
'                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {\n' +
'                        Array.Clear(buf, 0, outBytes);\n' +
'                    } else if (isFloat) {\n' +
'                        int total = (int)(frames * (uint)outCH);\n' +
'                        int sb = total * 4;\n' +
'                        if (floatBuf == null || floatBuf.Length < sb) floatBuf = new byte[sb];\n' +
'                        Marshal.Copy(data, floatBuf, 0, sb);\n' +
'                        for (int i = 0; i < total; i++) {\n' +
'                            float f = BitConverter.ToSingle(floatBuf, i * 4);\n' +
'                            short s = (short)Math.Max(-32768, Math.Min(32767, (int)(f * 32767)));\n' +
'                            buf[i * 2]     = (byte)(s & 0xFF);\n' +
'                            buf[i * 2 + 1] = (byte)((s >> 8) & 0xFF);\n' +
'                        }\n' +
'                    } else {\n' +
'                        Marshal.Copy(data, buf, 0, outBytes);\n' +
'                    }\n' +
'                    ms.Write(buf, 0, outBytes);\n' +
'                }\n' +
'                cc.ReleaseBuffer(frames);\n' +
'                cc.GetNextPacketSize(out pktSize);\n' +
'            }\n' +
'            if (ms.Length >= targetBytes) {\n' +
'                byte[] chunk = ms.ToArray(); ms.SetLength(0); ms.Position = 0;\n' +
'                string t = Path.Combine(tmpDir, "chunk_" + chunkIdx.ToString("D6") + ".raw.tmp");\n' +
'                string f = Path.Combine(tmpDir, "chunk_" + chunkIdx.ToString("D6") + ".raw");\n' +
'                File.WriteAllBytes(t, chunk); File.Move(t, f);\n' +
'                chunkIdx++;\n' +
'            }\n' +
'        }\n' +
'        ac.Stop();\n' +
'    }\n' +
'}\n' +
'\'@ \n' +
'\n' +
'try {\n' +
'    Add-Type -TypeDefinition $csharp -Language CSharp\n' +
'    [WasapiCapture]::Run($TmpDir)\n' +
'} catch {\n' +
'    $m = $_.ToString() -replace "[\\r\\n]+"," "\n' +
'    if ($m.Length -gt 200) { $m = $m.Substring(0,200) }\n' +
'    Set-Content (Join-Path $TmpDir "header.txt") "ERROR:$m" -Encoding ASCII\n' +
'}\n';
}

module.exports = obj;
