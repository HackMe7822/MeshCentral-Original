'use strict';
/*
 * win-audio-capture.js  (MeshAgent plugin module)
 *
 * Captures WASAPI loopback audio on Windows and streams raw PCM (Int16, LE)
 * through the protocol-201 relay tunnel to the browser.
 *
 * IPC: per-session temp dir with Base64 chunk files.
 *
 * Key behaviours:
 *  - WAIT keepalives every 3s keep the relay alive during PS startup.
 *  - Timeout logic is outside the main try-catch so _stopCapture() always runs.
 *  - Simple in-memory Add-Type (no DLL caching) to avoid double-load errors.
 *  - Full path to powershell.exe so SYSTEM-account PATH isn't relied on.
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
    var tmpDir = (env.TEMP || env.TMP || 'C:\\Windows\\Temp') + '\\mc-aud-' + sid;

    try { fs.mkdirSync(tmpDir); } catch (e) {
        try { tunnel.write('ERROR:mkdir failed: ' + String(e).substr(0, 80)); } catch (_x) {}
        return;
    }

    var csPath  = tmpDir + '\\wasapi.cs';
    var psPath  = tmpDir + '\\capture.ps1';
    var hdrPath = tmpDir + '\\header.txt';

    try { fs.writeFileSync(csPath, buildCS(),       { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:write .cs: ' + String(e).substr(0, 80)); } catch (_x) {}
        return;
    }
    try { fs.writeFileSync(psPath, buildPS(tmpDir), { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:write .ps1: ' + String(e).substr(0, 80)); } catch (_x) {}
        return;
    }

    // Pre-flight marker written by JS -- confirms JS side is working.
    // PS will overwrite with STARTING:ps_started once it runs.
    try { fs.writeFileSync(hdrPath, 'STARTING:js_started', { encoding: 'utf8' }); } catch (_x) {}

    // Full path: SYSTEM account PATH may not include PowerShell directory.
    var psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

    var proc = null;
    try {
        proc = cp.execFile(psExe, [
            '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath
        ], function (err) { /* file IPC -- nothing to do on process exit */ });
    } catch (e) {
        try { tunnel.write('ERROR:execFile failed: ' + String(e).substr(0, 80)); } catch (_x) {}
        return;
    }
    if (!proc) {
        try { tunnel.write('ERROR:execFile returned null (MeshAgent limitation?)'); } catch (_x) {}
        return;
    }

    var headerSent    = false;
    var chunkIdx      = 0;
    var startTime     = Date.now();
    var lastChunk     = Date.now();
    var lastKeepalive = Date.now();

    var pollId = setInterval(function () {
        if (!_active) { clearInterval(pollId); return; }

        var now = Date.now();

        // ---- Keepalive outside try-catch: always fires to keep relay alive ----
        if (!headerSent && (now - lastKeepalive) > 3000) {
            try { tunnel.write('WAIT'); } catch (_x) {}
            lastKeepalive = now;
        }

        // ---- Hard timeout outside try-catch: _stopCapture always runs ----
        if (!headerSent && (now - startTime) > 120000) {
            var lastHdr = 'unknown';
            try { lastHdr = String(fs.readFileSync(hdrPath, { encoding: 'utf8' })).trim().substr(0, 60); } catch (_x) {}
            try { tunnel.write('ERROR:120s timeout. Last PS status: ' + lastHdr); } catch (_x) {}
            obj._stopCapture();
            return;
        }

        if (headerSent && (now - lastChunk) > 10000) {
            try { tunnel.write('ERROR:Audio stream stalled (no chunks for 10s)'); } catch (_x) {}
            obj._stopCapture();
            return;
        }

        // ---- File IPC polling ----
        try {
            if (!headerSent) {
                var hdr = String(fs.readFileSync(hdrPath, { encoding: 'utf8' })).trim();
                if (!hdr || hdr.indexOf('STARTING') === 0) return; // still initialising
                // hdr is now  AUDIO:<sr>:<ch>:16  or  ERROR:<msg>
                tunnel.write(hdr);
                if (hdr.indexOf('ERROR:') === 0) { obj._stopCapture(); return; }
                headerSent = true;
                lastChunk  = now;
                return;
            }

            var chunkPath = tmpDir + '\\chunk_' + pad6(chunkIdx) + '.b64';
            if (!fs.existsSync(chunkPath)) return;

            var b64 = String(fs.readFileSync(chunkPath, { encoding: 'utf8' })).trim();
            if (b64.length > 0) {
                var buf     = Buffer.from(b64, 'base64');
                var aligned = Math.floor(buf.length / 4) * 4;
                if (aligned > 0) tunnel.write(buf.slice(0, aligned));
            }
            try { fs.unlinkSync(chunkPath); } catch (_x) {}
            chunkIdx++;
            lastChunk = now;
        } catch (e) { /* transient read error -- ignore */ }
    }, 20);

    _active = { proc: proc, tmpDir: tmpDir, pollId: pollId, fs: fs };
};

function pad6 (n) { return ('000000' + n).slice(-6); }

obj._stopCapture = function () {
    if (!_active) return;
    var a = _active; _active = null;
    try { clearInterval(a.pollId); } catch (_x) {}
    try { a.fs.writeFileSync(a.tmpDir + '\\stop.signal', '1'); } catch (_x) {}
    setTimeout(function () {
        try { if (a.proc) a.proc.kill(); } catch (_x) {}
        try {
            var files = a.fs.readdirSync(a.tmpDir);
            for (var i = 0; i < files.length; i++) {
                try { a.fs.unlinkSync(a.tmpDir + '\\' + files[i]); } catch (_x) {}
            }
            a.fs.rmdirSync(a.tmpDir);
        } catch (_x) {}
    }, 2000);
};

// ---- PowerShell wrapper -------------------------------------------------------
function buildPS (tmpDir) {
    var d = tmpDir.replace(/'/g, "''");
    return (
'$d = \'' + d + '\'\n' +
'Set-Content "$d\\header.txt" "STARTING:ps_started" -Encoding ASCII\n' +
'try {\n' +
'    $code = Get-Content "$d\\wasapi.cs" -Raw -Encoding UTF8\n' +
'    Set-Content "$d\\header.txt" "STARTING:add_type" -Encoding ASCII\n' +
'    Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop\n' +
'    [WasapiCapture]::Run($d)\n' +
'} catch {\n' +
'    $msg = ($_ | Out-String).Trim() -replace "[\\r\\n]+"," "\n' +
'    if ($msg.Length -gt 300) { $msg = $msg.Substring(0,300) }\n' +
'    Set-Content "$d\\header.txt" "ERROR:$msg" -Encoding ASCII\n' +
'}\n'
    );
}

// ---- C# WASAPI loopback source ------------------------------------------------
function buildCS () {
    return [
'using System;',
'using System.IO;',
'using System.Runtime.InteropServices;',
'using System.Threading;',
'',
'// IMMDeviceEnumerator: [Guid] must be the INTERFACE IID (A95664D2), not the coclass CLSID (BCDE0395)',
'[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDeviceEnumerator {',
'    void EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);',
'    void GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint);',
'    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IntPtr ppDevice);',
'    void RegisterEndpointNotificationCallback(IntPtr pClient);',
'    void UnregisterEndpointNotificationCallback(IntPtr pClient);',
'}',
'[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDevice {',
'    void Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);',
'    void OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);',
'    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);',
'    void GetState(out int pdwState);',
'}',
'[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IMMDeviceCollection {',
'    void GetCount(out uint pcDevices);',
'    void Item(uint nDevice, out IntPtr ppDevice);',
'}',
'[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IAudioClient {',
'    void Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration, long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);',
'    void GetBufferSize(out uint pNumBufferFrames);',
'    void GetStreamLatency(out long phnsLatency);',
'    void GetCurrentPadding(out uint pNumPaddingFrames);',
'    void IsFormatSupported(int ShareMode, ref WAVEFORMATEX pFormat, out IntPtr ppClosestMatch);',
'    void GetMixFormat(out IntPtr ppDeviceFormat);',
'    void GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);',
'    void Start(); void Stop(); void Reset();',
'    void SetEventHandle(IntPtr eventHandle);',
'    void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);',
'}',
'[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
'public interface IAudioCaptureClient {',
'    void GetBuffer(out IntPtr ppData, out uint pNumFramesAvailable, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);',
'    void ReleaseBuffer(uint NumFramesRead);',
'    void GetNextPacketSize(out uint pNumFramesInNextPacket);',
'}',
'[StructLayout(LayoutKind.Sequential)]',
'public struct WAVEFORMATEX {',
'    public ushort wFormatTag, nChannels;',
'    public uint   nSamplesPerSec, nAvgBytesPerSec;',
'    public ushort nBlockAlign, wBitsPerSample, cbSize;',
'}',
'public static class WasapiCapture {',
'    const uint LOOPBACK   = 0x00020000u;',
'    const uint SILENT     = 0x00000002u;',
'    const int  SHARED     = 0;',
'    const int  CLSCTX_ALL = 23;',
'    static readonly Guid IID_AC  = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");',
'    static readonly Guid IID_ACC = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");',
'    [DllImport("ole32.dll")] static extern void CoInitialize(IntPtr reserved);',
'',
'    static IMMDevice GetDefaultDevice(IMMDeviceEnumerator en) {',
'        try {',
'            IntPtr p; en.GetDefaultAudioEndpoint(0, 0, out p);',
'            var d = (IMMDevice)Marshal.GetObjectForIUnknown(p); Marshal.Release(p); return d;',
'        } catch {}',
'        IntPtr cp; en.EnumAudioEndpoints(0, 1, out cp);',
'        var col = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(cp); Marshal.Release(cp);',
'        uint c; col.GetCount(out c);',
'        if (c == 0) throw new Exception("No active render endpoints");',
'        IntPtr dp; col.Item(0, out dp);',
'        var dev = (IMMDevice)Marshal.GetObjectForIUnknown(dp); Marshal.Release(dp); return dev;',
'    }',
'',
'    public static void Run(string dir) {',
'        CoInitialize(IntPtr.Zero);',
'        var stop = Path.Combine(dir, "stop.signal");',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "STARTING:enum");',
'        var enumType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), true);',
'        var en       = (IMMDeviceEnumerator)Activator.CreateInstance(enumType);',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "STARTING:device");',
'        var dev = GetDefaultDevice(en);',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "STARTING:activate");',
'        IntPtr ap; dev.Activate(IID_AC, CLSCTX_ALL, IntPtr.Zero, out ap);',
'        var ac = (IAudioClient)Marshal.GetObjectForIUnknown(ap); Marshal.Release(ap);',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "STARTING:format");',
'        IntPtr fp; ac.GetMixFormat(out fp);',
'        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fp, typeof(WAVEFORMATEX));',
'        Marshal.FreeCoTaskMem(fp);',
'        bool isFloat = (fmt.wFormatTag == 3 || fmt.wFormatTag == 0xFFFE);',
'        int sr = (int)fmt.nSamplesPerSec;',
'        int ch = fmt.nChannels;',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "STARTING:init");',
'        ac.Initialize(SHARED, LOOPBACK, 100 * 10000L, 0, ref fmt, IntPtr.Zero);',
'',
'        IntPtr scp; ac.GetService(IID_ACC, out scp);',
'        var cc = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(scp); Marshal.Release(scp);',
'',
'        File.WriteAllText(Path.Combine(dir, "header.txt"), "AUDIO:" + sr + ":" + ch + ":16");',
'        ac.Start();',
'',
'        int bpf = ch * 2;',
'        int tgt = sr * bpf / 20; // ~50ms of PCM per chunk',
'        var ms  = new System.IO.MemoryStream();',
'        int idx = 0;',
'        byte[] floatBuf = null;',
'',
'        while (!File.Exists(stop)) {',
'            Thread.Sleep(10);',
'            uint ps2; cc.GetNextPacketSize(out ps2);',
'            while (ps2 > 0) {',
'                IntPtr dp; uint fr, fl; ulong dv, qv;',
'                cc.GetBuffer(out dp, out fr, out fl, out dv, out qv);',
'                int ob = (int)fr * bpf;',
'                if (ob > 0) {',
'                    var b = new byte[ob];',
'                    if ((fl & SILENT) != 0) {',
'                        Array.Clear(b, 0, ob);',
'                    } else if (isFloat) {',
'                        int tot = (int)(fr * (uint)ch);',
'                        int sb  = tot * 4;',
'                        if (floatBuf == null || floatBuf.Length < sb) floatBuf = new byte[sb];',
'                        Marshal.Copy(dp, floatBuf, 0, sb);',
'                        for (int i = 0; i < tot; i++) {',
'                            float f = BitConverter.ToSingle(floatBuf, i * 4);',
'                            short s = (short)Math.Max(-32768, Math.Min(32767, (int)(f * 32767)));',
'                            b[i * 2]     = (byte)(s & 0xFF);',
'                            b[i * 2 + 1] = (byte)((s >> 8) & 0xFF);',
'                        }',
'                    } else {',
'                        Marshal.Copy(dp, b, 0, ob);',
'                    }',
'                    ms.Write(b, 0, ob);',
'                }',
'                cc.ReleaseBuffer(fr);',
'                cc.GetNextPacketSize(out ps2);',
'            }',
'            if (ms.Length >= tgt) {',
'                byte[] chunk = ms.ToArray(); ms.SetLength(0); ms.Position = 0;',
'                string t  = Path.Combine(dir, "chunk_" + idx.ToString("D6") + ".b64.tmp");',
'                string f2 = Path.Combine(dir, "chunk_" + idx.ToString("D6") + ".b64");',
'                File.WriteAllText(t, Convert.ToBase64String(chunk));',
'                File.Move(t, f2);',
'                idx++;',
'            }',
'        }',
'        ac.Stop();',
'    }',
'}'
    ].join('\n');
}

module.exports = obj;
