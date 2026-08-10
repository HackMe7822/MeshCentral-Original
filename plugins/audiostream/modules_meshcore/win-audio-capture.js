'use strict';
/*
 * win-audio-capture.js — MeshAgent module (Windows only, auto-injected via win- prefix)
 *
 * Handles protocol 201 tunnel commands from the browser:
 *   'start'  → spawn WASAPI loopback helper in user session, stream PCM to browser
 *   'stop'   → kill helper process
 *
 * The helper is a PowerShell script that captures the default audio output
 * device via WASAPI loopback and writes:
 *   Line 1:  "AUDIO:<sampleRate>:<channels>:16\n"  (text)
 *   Rest:    raw 16-bit little-endian stereo PCM to stdout
 *
 * Session 0 isolation:
 *   MeshAgent runs in Session 0 (no audio). The helper spawns in the logged-in
 *   user session using child_process.SpawnTypes.USER + user-sessions.consoleUid().
 */

var obj = {};
var _active = null;  // { proc, tunnel }

// ── Called by meshcore.js for every data frame on protocol 201 ────────────────
obj.ontunneldata = function (data, tunnel) {
    var cmd = (typeof data === 'string') ? data.trim() : null;
    if      (cmd === 'start') { obj._startCapture(tunnel); }
    else if (cmd === 'stop')  { obj._stopCapture(); }
    // binary frames from browser are ignored (we only send, not receive audio)
};

// ── Start WASAPI capture in user session ──────────────────────────────────────
obj._startCapture = function (tunnel) {
    if (_active) obj._stopCapture();

    var fs    = require('fs');
    var path  = require('path');
    var cp    = require('child_process');

    var helperDir  = (process.env.PROGRAMDATA || 'C:\\ProgramData') + '\\CreationsIT';
    var helperPath = path.join(helperDir, 'mc-audio-helper.ps1');

    // Write helper script if missing or outdated
    try {
        if (!fs.existsSync(helperDir)) { fs.mkdirSync(helperDir); }
    } catch (e) {}

    try {
        fs.writeFileSync(helperPath, obj._getHelperScript(), 'utf8');
    } catch (e) {
        try {
            // Fallback: write to temp
            helperPath = path.join(require('_tempdir'), 'mc-audio-helper.ps1');
            fs.writeFileSync(helperPath, obj._getHelperScript(), 'utf8');
        } catch (e2) { return; }
    }

    // Determine user UID for user-session spawn
    var uid = -1;
    try {
        uid = require('user-sessions').consoleUid();
    } catch (e) {}

    var spawnOpts = {};
    try {
        if (uid >= 0) {
            spawnOpts.uid  = uid;
            spawnOpts.type = cp.SpawnTypes.USER;
        }
    } catch (e) {}

    var proc;
    try {
        proc = cp.execFile('powershell.exe',
            ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
            spawnOpts
        );
    } catch (e) { return; }

    _active = { proc: proc, tunnel: tunnel };

    var headerSent = false;

    proc.stdout.on('data', function (chunk) {
        if (!_active || !tunnel) { obj._stopCapture(); return; }

        try {
            if (!headerSent) {
                // First chunk may contain "AUDIO:sr:ch:16\n" followed by binary PCM.
                // Detect the header and send it as text, then stream binary.
                var str = chunk.toString('latin1');
                var nlIdx = str.indexOf('\n');
                if (nlIdx >= 0 && str.indexOf('AUDIO:') === 0) {
                    var headerLine = str.substring(0, nlIdx);        // "AUDIO:44100:2:16"
                    var binaryPart = chunk.slice(nlIdx + 1);         // rest is PCM bytes
                    headerSent = true;
                    // Send header as UTF-8 string
                    if (typeof tunnel.write === 'function') {
                        tunnel.write(Buffer.from(headerLine, 'utf8'));
                        if (binaryPart.length > 0) {
                            tunnel.write(binaryPart);
                        }
                    }
                    return;
                }
                // No header found yet (shouldn't happen) — treat as binary anyway
                headerSent = true;
            }
            if (typeof tunnel.write === 'function') {
                tunnel.write(chunk);
            }
        } catch (e) {
            // Browser disconnected — stop
            obj._stopCapture();
        }
    });

    proc.on('exit', function () {
        if (_active && _active.proc === proc) _active = null;
    });
};

// ── Stop capture ──────────────────────────────────────────────────────────────
obj._stopCapture = function () {
    if (_active) {
        try { _active.proc.kill(); } catch (e) {}
        _active = null;
    }
};

// ── Embedded PowerShell WASAPI helper script ─────────────────────────────────
obj._getHelperScript = function () {
    return [
        '# MeshCentral WASAPI Loopback Capture Helper',
        '# Captures default audio output device and writes PCM to stdout.',
        '# Output: "AUDIO:<sampleRate>:<channels>:16\\n" header, then raw Int16 LE PCM.',
        '',
        '$ErrorActionPreference = "Stop"',
        '',
        'Add-Type @"',
        'using System;',
        'using System.IO;',
        'using System.Threading;',
        'using System.Runtime.InteropServices;',
        '',
        '[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),',
        ' InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'public interface IMMDeviceEnumerator {',
        '    void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);',
        '    void GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint);',
        '    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr ppDevice);',
        '    void RegisterEndpointNotificationCallback(IntPtr pClient);',
        '    void UnregisterEndpointNotificationCallback(IntPtr pClient);',
        '}',
        '',
        '[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),',
        ' InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'public interface IMMDevice {',
        '    void Activate(ref Guid iid, int clsCtx, IntPtr pActivationParams, out IntPtr ppInterface);',
        '    void OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);',
        '    void GetId(out IntPtr ppstrId);',
        '    void GetState(out uint pdwState);',
        '}',
        '',
        '[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),',
        ' InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'public interface IAudioClient {',
        '    void Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);',
        '    void GetBufferSize(out uint pNumBufferFrames);',
        '    void GetStreamLatency(out long phnsLatency);',
        '    void GetCurrentPadding(out uint pNumPaddingFrames);',
        '    void IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);',
        '    void GetMixFormat(out IntPtr ppDeviceFormat);',
        '    void GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);',
        '    void Start();',
        '    void Stop();',
        '    void Reset();',
        '    void SetEventHandle(IntPtr eventHandle);',
        '    void GetService(ref Guid riid, out IntPtr ppv);',
        '}',
        '',
        '[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),',
        ' InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'public interface IAudioCaptureClient {',
        '    void GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);',
        '    void ReleaseBuffer(uint numFramesRead);',
        '    void GetNextPacketSize(out uint pNumFramesInNextPacket);',
        '}',
        '',
        'public static class WasapiCapture {',
        '    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");',
        '    static readonly Guid IID_IMMDeviceEnumerator  = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");',
        '    static readonly Guid IID_IAudioClient         = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");',
        '    static readonly Guid IID_IAudioCaptureClient  = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");',
        '',
        '    [DllImport("ole32.dll", PreserveSig = false)]',
        '    static extern void CoCreateInstance(',
        '        ref Guid rclsid, IntPtr pUnkOuter, int dwClsCtx,',
        '        ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);',
        '',
        '    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, int dwCoInit);',
        '    [DllImport("ole32.dll")] static extern void CoUninitialize();',
        '',
        '    public static void Run(Stream output) {',
        '        CoInitializeEx(IntPtr.Zero, 0); // COINIT_APARTMENTTHREADED',
        '        try {',
        '            var clsid = CLSID_MMDeviceEnumerator;',
        '            var iid   = IID_IMMDeviceEnumerator;',
        '            object enumObj;',
        '            CoCreateInstance(ref clsid, IntPtr.Zero, 0x17, ref iid, out enumObj);',
        '            var enumerator = (IMMDeviceEnumerator)enumObj;',
        '',
        '            IntPtr devPtr;',
        '            enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out devPtr);',
        '            var device = (IMMDevice)Marshal.GetObjectForIUnknown(devPtr);',
        '            Marshal.Release(devPtr);',
        '',
        '            IntPtr acPtr;',
        '            var acIid = IID_IAudioClient;',
        '            device.Activate(ref acIid, 0x17, IntPtr.Zero, out acPtr);',
        '            var audioClient = (IAudioClient)Marshal.GetObjectForIUnknown(acPtr);',
        '            Marshal.Release(acPtr);',
        '',
        '            // Get native mix format (usually 32-bit float on modern Windows)',
        '            IntPtr fmtPtr;',
        '            audioClient.GetMixFormat(out fmtPtr);',
        '',
        '            short fmtTag       = Marshal.ReadInt16(fmtPtr, 0);',
        '            short fmtChannels  = Marshal.ReadInt16(fmtPtr, 2);',
        '            int   fmtSampleRate = Marshal.ReadInt32(fmtPtr, 4);',
        '            short fmtBitsPerSample = Marshal.ReadInt16(fmtPtr, 14);',
        '            bool  isFloat = (fmtTag == 3) || (fmtTag == -2 && fmtBitsPerSample == 32);',
        '',
        '            // Initialize loopback capture with the mix format',
        '            // AUDCLNT_SHAREMODE_SHARED = 0, AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000',
        '            audioClient.Initialize(0, 0x00020000, 10000000L, 0, fmtPtr, IntPtr.Zero);',
        '            Marshal.FreeCoTaskMem(fmtPtr);',
        '',
        '            IntPtr ccPtr;',
        '            var ccIid = IID_IAudioCaptureClient;',
        '            audioClient.GetService(ref ccIid, out ccPtr);',
        '            var captureClient = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(ccPtr);',
        '            Marshal.Release(ccPtr);',
        '',
        '            // Send header: AUDIO:sampleRate:channels:16',
        '            byte[] header = System.Text.Encoding.ASCII.GetBytes(',
        '                "AUDIO:" + fmtSampleRate + ":" + fmtChannels + ":16\\n");',
        '            output.Write(header, 0, header.Length);',
        '            output.Flush();',
        '',
        '            audioClient.Start();',
        '',
        '            byte[] convBuf = null;',
        '            try {',
        '                while (true) {',
        '                    Thread.Sleep(10);',
        '                    uint nextPkt;',
        '                    captureClient.GetNextPacketSize(out nextPkt);',
        '                    while (nextPkt > 0) {',
        '                        IntPtr dataPtr;',
        '                        uint numFrames, flags;',
        '                        ulong devPos, qpcPos;',
        '                        captureClient.GetBuffer(out dataPtr, out numFrames, out flags,',
        '                            out devPos, out qpcPos);',
        '',
        '                        int outBytes = (int)(numFrames * fmtChannels * 2); // 16-bit output',
        '                        if (convBuf == null || convBuf.Length < outBytes)',
        '                            convBuf = new byte[outBytes];',
        '',
        '                        if (numFrames > 0) {',
        '                            if (isFloat) {',
        '                                // 32-bit float -> 16-bit int',
        '                                byte[] tmp = new byte[4];',
        '                                for (int i = 0; i < (int)(numFrames * fmtChannels); i++) {',
        '                                    Marshal.Copy(new IntPtr(dataPtr.ToInt64() + i * 4), tmp, 0, 4);',
        '                                    float f = BitConverter.ToSingle(tmp, 0);',
        '                                    short s = (short)Math.Max(-32768, Math.Min(32767, (int)(f * 32767)));',
        '                                    convBuf[i * 2]     = (byte)(s & 0xFF);',
        '                                    convBuf[i * 2 + 1] = (byte)((s >> 8) & 0xFF);',
        '                                }',
        '                            } else {',
        '                                // Already 16-bit int, copy directly',
        '                                Marshal.Copy(dataPtr, convBuf, 0, outBytes);',
        '                            }',
        '                            output.Write(convBuf, 0, outBytes);',
        '                        }',
        '                        captureClient.ReleaseBuffer(numFrames);',
        '                        captureClient.GetNextPacketSize(out nextPkt);',
        '                    }',
        '                    output.Flush();',
        '                }',
        '            } catch (IOException) {',
        '                // Parent closed stdout/pipe — exit cleanly',
        '            } finally {',
        '                try { audioClient.Stop(); } catch {}',
        '            }',
        '        } finally {',
        '            CoUninitialize();',
        '        }',
        '    }',
        '}',
        '"@ -Language CSharp',
        '',
        '# Run capture — writes to stdout',
        'try {',
        '    [WasapiCapture]::Run([Console]::OpenStandardOutput())',
        '} catch {',
        '    Write-Error $_',
        '    exit 1',
        '}'
    ].join('\n');
};

module.exports = obj;
