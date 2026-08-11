'use strict';
/*
 * win-audio-capture.js  (MeshAgent plugin module, win- prefix = auto-injected on Windows)
 *
 * IPC strategy: file-based chunks using Base64 text files in a per-session temp dir.
 *   Why Base64?  fs.readFileSync in MeshAgent may return a string instead of a Buffer.
 *   Sending a string via tunnel.write() = text WebSocket frame, not binary.
 *   Base64 round-trip guarantees: PS writes text -> agent reads text -> Buffer.from(b64)
 *   -> tunnel.write(Buffer) -> binary WebSocket frame -> browser ArrayBuffer. No ambiguity.
 *
 *   Why separate .cs file?  PowerShell here-strings (@'...'@) are finicky about the
 *   closing marker.  Writing C# to a plain .cs file and loading with Get-Content sidesteps
 *   all escaping and whitespace issues.
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

    var sid    = Math.random().toString(36).substr(2, 8);
    var tmpDir = (env.TEMP || env.tmp || 'C:\\Windows\\Temp') + '\\mc-aud-' + sid;

    try { fs.mkdirSync(tmpDir); } catch (e) {
        try { tunnel.write('ERROR:Cannot create temp dir: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    var csPath = tmpDir + '\\wasapi.cs';
    var psPath = tmpDir + '\\capture.ps1';

    try { fs.writeFileSync(csPath, buildCS(),         { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:Cannot write .cs: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }
    try { fs.writeFileSync(psPath, buildPS(tmpDir),   { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:Cannot write .ps1: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    // Use callback form — some MeshAgent builds require it to actually spawn the process
    var proc = null;
    try {
        proc = cp.execFile('powershell.exe', [
            '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath
        ], function (err) {
            // Process exited; IPC continues via files -- nothing to do here
        });
    } catch (e) {
        try { tunnel.write('ERROR:Cannot spawn PowerShell: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }
    if (!proc) {
        try { tunnel.write('ERROR:execFile returned null -- PowerShell did not start'); } catch (_) {}
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
                var elapsed = now - startTime;
                // Give up to 60s for Add-Type to compile C# on first run
                if (elapsed > 60000) {
                    tunnel.write('ERROR:60s timeout -- PowerShell/Add-Type may have failed. Check agent temp dir.');
                    obj._stopCapture(); return;
                }
                var hdrPath = tmpDir + '\\header.txt';
                if (!fs.existsSync(hdrPath)) return;
                var hdr = String(fs.readFileSync(hdrPath, { encoding: 'utf8' })).trim();
                if (!hdr || hdr === 'STARTING') return;  // still compiling -- keep waiting
                tunnel.write(hdr);               // either "AUDIO:sr:ch:16" or "ERROR:..."
                if (hdr.indexOf('ERROR:') === 0) { obj._stopCapture(); return; }
                headerSent = true;
                lastChunk  = now;
                return;
            }

            if (now - lastChunk > 10000) {
                tunnel.write('ERROR:Audio stream stalled -- WASAPI may have stopped');
                obj._stopCapture(); return;
            }

            var chunkPath = tmpDir + '\\chunk_' + pad6(chunkIdx) + '.b64';
            if (!fs.existsSync(chunkPath)) return;

            // Read Base64 text, decode to Buffer, send as binary frame
            var b64 = String(fs.readFileSync(chunkPath, { encoding: 'utf8' })).trim();
            if (b64.length > 0) {
                var buf = Buffer.from(b64, 'base64');
                // Align to 4-byte int16-stereo boundary
                var aligned = Math.floor(buf.length / 4) * 4;
                if (aligned > 0) tunnel.write(buf.slice(0, aligned));
            }
            try { fs.unlinkSync(chunkPath); } catch (_) {}
            chunkIdx++;
            lastChunk = now;
        } catch (e) {
            // Transient file-not-ready errors are normal -- ignore
        }
    }, 20);

    _active = { proc: proc, tmpDir: tmpDir, pollId: pollId, fs: fs };
};

function pad6 (n) { return ('000000' + n).slice(-6); }

obj._stopCapture = function () {
    if (!_active) return;
    var a  = _active; _active = null;
    if (a.pollId) { try { clearInterval(a.pollId); } catch (_) {} }
    try { a.fs.writeFileSync(a.tmpDir + '\\stop.signal', '1'); } catch (_) {}
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

// ---- C# WASAPI loopback source (written to wasapi.cs, no PS escaping needed) --------
function buildCS () {
    return [
'using System;',
'using System.IO;',
'using System.Runtime.InteropServices;',
'using System.Threading;',
'',
'[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDeviceEnumerator {',
'    void EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);',
'    void GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint);',
'    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IntPtr ppDevice);',
'    void RegisterEndpointNotificationCallback(IntPtr pClient);',
'    void UnregisterEndpointNotificationCallback(IntPtr pClient);',
'}',
'',
'[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDevice {',
'    void Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int dwClsCtx,',
'        IntPtr pActivationParams, out IntPtr ppInterface);',
'    void OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);',
'    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);',
'    void GetState(out int pdwState);',
'}',
'',
'[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDeviceCollection {',
'    void GetCount(out uint pcDevices);',
'    void Item(uint nDevice, out IntPtr ppDevice);',
'}',
'',
'[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IAudioClient {',
'    void Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration,',
'        long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);',
'    void GetBufferSize(out uint pNumBufferFrames);',
'    void GetStreamLatency(out long phnsLatency);',
'    void GetCurrentPadding(out uint pNumPaddingFrames);',
'    void IsFormatSupported(int ShareMode, ref WAVEFORMATEX pFormat, out IntPtr ppClosestMatch);',
'    void GetMixFormat(out IntPtr ppDeviceFormat);',
'    void GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);',
'    void Start();',
'    void Stop();',
'    void Reset();',
'    void SetEventHandle(IntPtr eventHandle);',
'    void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);',
'}',
'',
'[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IAudioCaptureClient {',
'    void GetBuffer(out IntPtr ppData, out uint pNumFramesAvailable,',
'        out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);',
'    void ReleaseBuffer(uint NumFramesRead);',
'    void GetNextPacketSize(out uint pNumFramesInNextPacket);',
'}',
'',
'[StructLayout(LayoutKind.Sequential)]',
'public struct WAVEFORMATEX {',
'    public ushort wFormatTag, nChannels;',
'    public uint   nSamplesPerSec, nAvgBytesPerSec;',
'    public ushort nBlockAlign, wBitsPerSample, cbSize;',
'}',
'',
'public static class WasapiCapture {',
'    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000u;',
'    const uint AUDCLNT_BUFFERFLAGS_SILENT   = 0x00000002u;',
'    const int  AUDCLNT_SHAREMODE_SHARED     = 0;',
'    const int  CLSCTX_ALL                   = 23;',
'',
'    static readonly Guid IID_IAudioClient        = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");',
'    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");',
'',
'    [DllImport("ole32")] static extern int CoCreateInstance(',
'        [MarshalAs(UnmanagedType.LPStruct)] Guid clsid, IntPtr pUnkOuter,',
'        int dwClsContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);',
'    [DllImport("ole32")] static extern void CoInitialize(IntPtr reserved);',
'',
'    static IMMDevice GetDevice(IMMDeviceEnumerator en) {',
'        IntPtr p;',
'        try {',
'            en.GetDefaultAudioEndpoint(0, 0, out p);',
'            var d = (IMMDevice)Marshal.GetObjectForIUnknown(p);',
'            Marshal.Release(p);',
'            return d;',
'        } catch {}',
'        // Fallback: enumerate active render endpoints',
'        en.EnumAudioEndpoints(0, 1, out p);',
'        var col = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(p);',
'        Marshal.Release(p);',
'        uint cnt; col.GetCount(out cnt);',
'        if (cnt == 0) throw new Exception("No active audio render endpoints found");',
'        IntPtr dp; col.Item(0, out dp);',
'        var dev = (IMMDevice)Marshal.GetObjectForIUnknown(dp);',
'        Marshal.Release(dp);',
'        return dev;',
'    }',
'',
'    public static void Run(string tmpDir) {',
'        CoInitialize(IntPtr.Zero);',
'        var stopPath = Path.Combine(tmpDir, "stop.signal");',
'',
'        var mmClsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");',
'        var mmIid   = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");',
'        IntPtr ep; CoCreateInstance(mmClsid, IntPtr.Zero, CLSCTX_ALL, mmIid, out ep);',
'        var enumerator = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(ep);',
'        Marshal.Release(ep);',
'',
'        var device = GetDevice(enumerator);',
'',
'        IntPtr acPtr;',
'        device.Activate(IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out acPtr);',
'        var ac = (IAudioClient)Marshal.GetObjectForIUnknown(acPtr);',
'        Marshal.Release(acPtr);',
'',
'        IntPtr fmtPtr; ac.GetMixFormat(out fmtPtr);',
'        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));',
'        Marshal.FreeCoTaskMem(fmtPtr);',
'',
'        bool isFloat = (fmt.wFormatTag == 3);',
'        int  outSR   = (int)fmt.nSamplesPerSec;',
'        int  outCH   = fmt.nChannels;',
'',
'        ac.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,',
'            100 * 10000L, 0, ref fmt, IntPtr.Zero);',
'',
'        IntPtr ccPtr; ac.GetService(IID_IAudioCaptureClient, out ccPtr);',
'        var cc = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(ccPtr);',
'        Marshal.Release(ccPtr);',
'',
'        // Write AUDIO header BEFORE starting -- agent sees it and changes button to "live"',
'        File.WriteAllText(Path.Combine(tmpDir, "header.txt"),',
'            "AUDIO:" + outSR + ":" + outCH + ":16");',
'',
'        ac.Start();',
'',
'        int bytesPerFrame = outCH * 2;',
'        int targetBytes   = outSR * bytesPerFrame / 20;  // 50 ms per chunk',
'        var ms       = new MemoryStream();',
'        int chunkIdx = 0;',
'        byte[] floatBuf = null;',
'',
'        while (!File.Exists(stopPath)) {',
'            Thread.Sleep(10);',
'            uint pktSize; cc.GetNextPacketSize(out pktSize);',
'            while (pktSize > 0) {',
'                IntPtr dataPtr; uint frames, flags; ulong dp2, qp;',
'                cc.GetBuffer(out dataPtr, out frames, out flags, out dp2, out qp);',
'                int outBytes = (int)frames * bytesPerFrame;',
'                if (outBytes > 0) {',
'                    var convBuf = new byte[outBytes];',
'                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {',
'                        Array.Clear(convBuf, 0, outBytes);',
'                    } else if (isFloat) {',
'                        int total = (int)(frames * (uint)outCH);',
'                        int sb = total * 4;',
'                        if (floatBuf == null || floatBuf.Length < sb) floatBuf = new byte[sb];',
'                        Marshal.Copy(dataPtr, floatBuf, 0, sb);',
'                        for (int i = 0; i < total; i++) {',
'                            float f = BitConverter.ToSingle(floatBuf, i * 4);',
'                            short s = (short)Math.Max(-32768, Math.Min(32767, (int)(f * 32767)));',
'                            convBuf[i * 2]     = (byte)(s & 0xFF);',
'                            convBuf[i * 2 + 1] = (byte)((s >> 8) & 0xFF);',
'                        }',
'                    } else {',
'                        Marshal.Copy(dataPtr, convBuf, 0, outBytes);',
'                    }',
'                    ms.Write(convBuf, 0, outBytes);',
'                }',
'                cc.ReleaseBuffer(frames);',
'                cc.GetNextPacketSize(out pktSize);',
'            }',
'            if (ms.Length >= targetBytes) {',
'                byte[] chunk = ms.ToArray();',
'                ms.SetLength(0); ms.Position = 0;',
'                // Atomic write: write .tmp then rename',
'                string tmp   = Path.Combine(tmpDir, "chunk_" + chunkIdx.ToString("D6") + ".b64.tmp");',
'                string final = Path.Combine(tmpDir, "chunk_" + chunkIdx.ToString("D6") + ".b64");',
'                File.WriteAllText(tmp, Convert.ToBase64String(chunk));',
'                File.Move(tmp, final);',
'                chunkIdx++;',
'            }',
'        }',
'        ac.Stop();',
'    }',
'}'
].join('\n');
}

// ---- Simple PowerShell wrapper (reads the .cs file, no here-string) -----------------
function buildPS (tmpDir) {
    var d = tmpDir.replace(/'/g, "''");   // escape single quotes for PS single-quoted strings
    return (
'$d = \'' + d + '\'\n' +
'# Signal to agent that PowerShell started (before compile which takes up to 30s)\n' +
'Set-Content "$d\\header.txt" "STARTING" -Encoding ASCII\n' +
'try {\n' +
'    $code = Get-Content "$d\\wasapi.cs" -Raw -Encoding UTF8\n' +
'    Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop\n' +
'    [WasapiCapture]::Run($d)\n' +
'} catch {\n' +
'    $msg = ($_ | Out-String).Trim() -replace "[\\r\\n]+"," "\n' +
'    if ($msg.Length -gt 250) { $msg = $msg.Substring(0,250) }\n' +
'    Set-Content "$d\\header.txt" "ERROR:$msg" -Encoding ASCII\n' +
'}\n'
    );
}

module.exports = obj;
