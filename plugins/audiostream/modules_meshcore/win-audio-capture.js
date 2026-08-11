'use strict';
/*
 * win-audio-capture.js  (MeshAgent plugin module)
 *
 * IPC: per-session temp dir with Base64 chunk files.
 *   PS writes STARTING:<phase>, then AUDIO:sr:ch:16 when ready.
 *
 * Two key behaviours:
 *   1. KEEPALIVE: agent sends "WAIT" through the relay every 5s while PS is
 *      starting up.  This prevents the relay from timing out during the
 *      ~30s Add-Type C# compilation on first run.  The browser silently
 *      ignores "WAIT" messages (they match none of the handled prefixes).
 *
 *   2. DLL CACHE: PS saves the compiled assembly to %TEMP%\mc-wasapi-<hash>.dll.
 *      Subsequent clicks load the pre-compiled DLL in < 1s (no recompile).
 *
 *   3. Correct COM IID: IMMDeviceEnumerator [Guid] = A95664D2 (IID), not
 *      BCDE0395 (coclass CLSID).  Wrong GUID -> QI returns E_NOINTERFACE.
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

    try { fs.writeFileSync(csPath, buildCS(),       { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:Cannot write .cs: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }
    try { fs.writeFileSync(psPath, buildPS(tmpDir), { encoding: 'utf8' }); } catch (e) {
        try { tunnel.write('ERROR:Cannot write .ps1: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }

    var proc = null;
    try {
        proc = cp.execFile('powershell.exe', [
            '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath
        ], function (err) { /* IPC via files -- nothing to do on exit */ });
    } catch (e) {
        try { tunnel.write('ERROR:Cannot spawn PowerShell: ' + String(e).substr(0, 80)); } catch (_) {}
        return;
    }
    if (!proc) {
        try { tunnel.write('ERROR:execFile returned null'); } catch (_) {}
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

        // ---- Keepalive: ping relay every 5s so it doesn't timeout during Add-Type ----
        if (!headerSent && now - lastKeepalive > 5000) {
            try { tunnel.write('WAIT'); } catch (_) {}
            lastKeepalive = now;
        }

        try {
            if (!headerSent) {
                if (now - startTime > 90000) {
                    tunnel.write('ERROR:90s timeout -- PS may have failed silently');
                    obj._stopCapture(); return;
                }
                var hdrPath = tmpDir + '\\header.txt';
                if (!fs.existsSync(hdrPath)) return;
                var hdr = String(fs.readFileSync(hdrPath, { encoding: 'utf8' })).trim();
                if (!hdr || hdr.indexOf('STARTING') === 0) return;  // still initialising
                tunnel.write(hdr);   // AUDIO:sr:ch:16  or  ERROR:...
                if (hdr.indexOf('ERROR:') === 0) { obj._stopCapture(); return; }
                headerSent = true;
                lastChunk  = now;
                return;
            }

            if (now - lastChunk > 10000) {
                tunnel.write('ERROR:Audio stream stalled');
                obj._stopCapture(); return;
            }

            var chunkPath = tmpDir + '\\chunk_' + pad6(chunkIdx) + '.b64';
            if (!fs.existsSync(chunkPath)) return;

            var b64 = String(fs.readFileSync(chunkPath, { encoding: 'utf8' })).trim();
            if (b64.length > 0) {
                var buf     = Buffer.from(b64, 'base64');
                var aligned = Math.floor(buf.length / 4) * 4;
                if (aligned > 0) tunnel.write(buf.slice(0, aligned));
            }
            try { fs.unlinkSync(chunkPath); } catch (_) {}
            chunkIdx++;
            lastChunk = now;
        } catch (e) { /* transient -- ignore */ }
    }, 20);

    _active = { proc: proc, tmpDir: tmpDir, pollId: pollId, fs: fs };
};

function pad6 (n) { return ('000000' + n).slice(-6); }

obj._stopCapture = function () {
    if (!_active) return;
    var a = _active; _active = null;
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

// ---- C# WASAPI loopback source ---------------------------------------------------
function buildCS () {
    return [
'using System;',
'using System.IO;',
'using System.Runtime.InteropServices;',
'using System.Threading;',
'',
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
'    void Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int dwClsCtx,',
'        IntPtr pActivationParams, out IntPtr ppInterface);',
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
'    void Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration,',
'        long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);',
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
'    void GetBuffer(out IntPtr ppData, out uint pNumFramesAvailable,',
'        out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);',
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
'    const uint LOOPBACK = 0x00020000u, SILENT = 0x00000002u;',
'    const int  SHARED = 0, CLSCTX_ALL = 23;',
'    static readonly Guid IID_AC  = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");',
'    static readonly Guid IID_ACC = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");',
'    [DllImport("ole32")] static extern void CoInitialize(IntPtr r);',
'    static IMMDevice GetDevice(IMMDeviceEnumerator en) {',
'        IntPtr p;',
'        try { en.GetDefaultAudioEndpoint(0,0,out p); var d=(IMMDevice)Marshal.GetObjectForIUnknown(p); Marshal.Release(p); return d; } catch {}',
'        en.EnumAudioEndpoints(0,1,out p);',
'        var col=(IMMDeviceCollection)Marshal.GetObjectForIUnknown(p); Marshal.Release(p);',
'        uint c; col.GetCount(out c);',
'        if(c==0) throw new Exception("No active audio render endpoints found");',
'        IntPtr dp; col.Item(0,out dp); var d2=(IMMDevice)Marshal.GetObjectForIUnknown(dp); Marshal.Release(dp); return d2;',
'    }',
'    public static void Run(string dir) {',
'        CoInitialize(IntPtr.Zero);',
'        var stop = Path.Combine(dir,"stop.signal");',
'        File.WriteAllText(Path.Combine(dir,"header.txt"),"STARTING:enum");',
'        var et = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"),true);',
'        var en = (IMMDeviceEnumerator)Activator.CreateInstance(et);',
'        File.WriteAllText(Path.Combine(dir,"header.txt"),"STARTING:device");',
'        var dev = GetDevice(en);',
'        File.WriteAllText(Path.Combine(dir,"header.txt"),"STARTING:activate");',
'        IntPtr ap; dev.Activate(IID_AC,CLSCTX_ALL,IntPtr.Zero,out ap);',
'        var ac=(IAudioClient)Marshal.GetObjectForIUnknown(ap); Marshal.Release(ap);',
'        IntPtr fp; ac.GetMixFormat(out fp);',
'        var fmt=(WAVEFORMATEX)Marshal.PtrToStructure(fp,typeof(WAVEFORMATEX)); Marshal.FreeCoTaskMem(fp);',
'        bool isFloat=(fmt.wFormatTag==3||fmt.wFormatTag==0xFFFE);',
'        int sr=(int)fmt.nSamplesPerSec, ch=fmt.nChannels;',
'        File.WriteAllText(Path.Combine(dir,"header.txt"),"STARTING:init");',
'        ac.Initialize(SHARED,LOOPBACK,100*10000L,0,ref fmt,IntPtr.Zero);',
'        IntPtr cp2; ac.GetService(IID_ACC,out cp2);',
'        var cc=(IAudioCaptureClient)Marshal.GetObjectForIUnknown(cp2); Marshal.Release(cp2);',
'        File.WriteAllText(Path.Combine(dir,"header.txt"),"AUDIO:"+sr+":"+ch+":16");',
'        ac.Start();',
'        int bpf=ch*2, tgt=sr*bpf/20;',
'        var ms=new MemoryStream(); int idx=0; byte[] fb=null;',
'        while(!File.Exists(stop)){',
'            Thread.Sleep(10);',
'            uint ps2; cc.GetNextPacketSize(out ps2);',
'            while(ps2>0){',
'                IntPtr dp2; uint fr,fl; ulong dv,qv;',
'                cc.GetBuffer(out dp2,out fr,out fl,out dv,out qv);',
'                int ob=(int)fr*bpf;',
'                if(ob>0){',
'                    var b=new byte[ob];',
'                    if((fl&SILENT)!=0){ Array.Clear(b,0,ob); }',
'                    else if(isFloat){',
'                        int tot=(int)(fr*(uint)ch), sb=tot*4;',
'                        if(fb==null||fb.Length<sb) fb=new byte[sb];',
'                        Marshal.Copy(dp2,fb,0,sb);',
'                        for(int i=0;i<tot;i++){',
'                            float f=BitConverter.ToSingle(fb,i*4);',
'                            short s=(short)Math.Max(-32768,Math.Min(32767,(int)(f*32767)));',
'                            b[i*2]=(byte)(s&0xFF); b[i*2+1]=(byte)((s>>8)&0xFF);',
'                        }',
'                    } else { Marshal.Copy(dp2,b,0,ob); }',
'                    ms.Write(b,0,ob);',
'                }',
'                cc.ReleaseBuffer(fr); cc.GetNextPacketSize(out ps2);',
'            }',
'            if(ms.Length>=tgt){',
'                byte[] chunk=ms.ToArray(); ms.SetLength(0); ms.Position=0;',
'                string t=Path.Combine(dir,"chunk_"+idx.ToString("D6")+".b64.tmp");',
'                string f2=Path.Combine(dir,"chunk_"+idx.ToString("D6")+".b64");',
'                File.WriteAllText(t,Convert.ToBase64String(chunk)); File.Move(t,f2); idx++;',
'            }',
'        }',
'        ac.Stop();',
'    }',
'}'
    ].join('\n');
}

// ---- PowerShell wrapper with DLL caching -----------------------------------------
// Uses MD5 hash of C# source as DLL filename so a code change auto-recompiles.
function buildPS (tmpDir) {
    var d = tmpDir.replace(/'/g, "''");
    return (
'$d = \'' + d + '\'\n' +
'Set-Content "$d\\header.txt" "STARTING:ps_started" -Encoding ASCII\n' +
'try {\n' +
'    $code = Get-Content "$d\\wasapi.cs" -Raw -Encoding UTF8\n' +
'    # Hash source so a new deployment auto-recompiles\n' +
'    $md5  = [System.Security.Cryptography.MD5]::Create()\n' +
'    $hash = ($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($code)) | ForEach-Object { $_.ToString("x2") }) -join ""\n' +
'    $dll  = [System.IO.Path]::Combine($env:TEMP, "mc-wasapi-$($hash.Substring(0,8)).dll")\n' +
'    if (-not (Test-Path $dll)) {\n' +
'        Set-Content "$d\\header.txt" "STARTING:compiling_first_time" -Encoding ASCII\n' +
'        Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $dll -ErrorAction Stop\n' +
'    }\n' +
'    Set-Content "$d\\header.txt" "STARTING:loading_dll" -Encoding ASCII\n' +
'    Add-Type -Path $dll -ErrorAction Stop\n' +
'    [WasapiCapture]::Run($d)\n' +
'} catch {\n' +
'    $msg = ($_ | Out-String).Trim() -replace "[\\r\\n]+"," "\n' +
'    if ($msg.Length -gt 300) { $msg = $msg.Substring(0,300) }\n' +
'    Set-Content "$d\\header.txt" "ERROR:$msg" -Encoding ASCII\n' +
'}\n'
    );
}

module.exports = obj;
