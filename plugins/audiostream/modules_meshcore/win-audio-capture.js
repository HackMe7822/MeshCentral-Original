'use strict';
/*
 * win-audio-capture.js  (audiostream plugin – agent module) v4
 *
 * v4 additions over v3:
 *   - listDevices → DEVICES:<json>  enumerate all active render endpoints with names
 *   - start:<idx>                   capture a specific endpoint by IMMDeviceCollection index
 *   - _cacheDevIdx                  cache is device-specific; reinit when device changes
 *
 * Root cause of "LDB audio missing": WASAPI loopback on the default render endpoint
 * only captures audio routed to THAT endpoint.  Some apps (Respondus Lockdown Browser,
 * HDMI audio, virtual cable drivers) use a non-default endpoint.  Enumerating all
 * endpoints and letting the user pick fixes this.
 */

var _cache       = null;
var _cacheDevIdx = -1;   // which IMMDeviceCollection index the cache is for (-1=default)
var _active      = null;

var obj = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Read a null-terminated UTF-16LE string from a _GenericMarshal pointer object.
function _readWStr(GM, k32, ptrObj, maxBytes) {
    try {
        var buf = GM.CreateVariable(maxBytes);
        k32.RtlMoveMemory(buf, ptrObj, maxBytes);
        var arr = buf.toBuffer(), s = '';
        for (var i = 0; i < maxBytes / 2; i++) {
            var c = arr.readUInt16LE(i * 2);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    } catch (_e) { return ''; }
}

// Create and return an IMMDeviceEnumerator COM object.
function _makeEnumerator(GM, _COM) {
    var pEn = _COM.createInstance(
        _COM.CLSIDFromString('{BCDE0395-E52F-467C-8E3D-C4579291692E}'),
        _COM.IID_IUnknown
    );
    pEn.funcs = _COM.marshalFunctions(pEn, [
        'QueryInterface','AddRef','Release',
        'EnumAudioEndpoints','GetDefaultAudioEndpoint','GetDevice',
        'RegisterEndpointNotificationCallback','UnregisterEndpointNotificationCallback'
    ]);
    return pEn;
}

// Enumerate all active render endpoints; return [{idx, name}].
// name includes ' ★' suffix on the system-default device.
function _getDevices(GM, _COM, k32) {
    var result = [];
    try {
        var pEn = _makeEnumerator(GM, _COM);

        // Get default device ID so we can mark it in the list.
        var defId = '';
        try {
            var defDevPtr = GM.CreatePointer();
            if (pEn.funcs.GetDefaultAudioEndpoint(pEn, 0, 0, defDevPtr).Val === 0) {
                var defDev = defDevPtr.Deref();
                defDev.funcs = _COM.marshalFunctions(defDev, [
                    'QueryInterface','AddRef','Release',
                    'Activate','OpenPropertyStore','GetId','GetState'
                ]);
                var defIdOut = GM.CreatePointer();
                if (defDev.funcs.GetId(defDev, defIdOut).Val === 0)
                    defId = _readWStr(GM, k32, defIdOut.Deref(), 300);
            }
        } catch (_de) {}

        // Enumerate all active render endpoints.
        var pCollPtr = GM.CreatePointer();
        if (pEn.funcs.EnumAudioEndpoints(pEn, 0, 1, pCollPtr).Val !== 0) return result;
        var pColl = pCollPtr.Deref();
        pColl.funcs = _COM.marshalFunctions(pColl, [
            'QueryInterface','AddRef','Release','GetCount','Item'
        ]);

        var cntV = GM.CreateVariable(4);
        pColl.funcs.GetCount(pColl, cntV);
        var count = Math.min(cntV.toBuffer().readUInt32LE(), 16);

        for (var i = 0; i < count; i++) {
            var devPtr = GM.CreatePointer();
            if (pColl.funcs.Item(pColl, i, devPtr).Val !== 0) continue;
            var pDv = devPtr.Deref();
            pDv.funcs = _COM.marshalFunctions(pDv, [
                'QueryInterface','AddRef','Release',
                'Activate','OpenPropertyStore','GetId','GetState'
            ]);

            // Device ID (for default-detection).
            var devId = '';
            try {
                var idOut = GM.CreatePointer();
                if (pDv.funcs.GetId(pDv, idOut).Val === 0)
                    devId = _readWStr(GM, k32, idOut.Deref(), 300);
            } catch (_ie) {}

            // Friendly name via IPropertyStore + PKEY_Device_FriendlyName.
            var name = 'Audio Device ' + (i + 1);
            try {
                var propPtr = GM.CreatePointer();
                if (pDv.funcs.OpenPropertyStore(pDv, 0, propPtr).Val === 0) {
                    var pProp = propPtr.Deref();
                    pProp.funcs = _COM.marshalFunctions(pProp, [
                        'QueryInterface','AddRef','Release',
                        'GetCount','GetAt','GetValue','SetValue','Commit'
                    ]);
                    // PKEY_Device_FriendlyName = {A45C254E-DF1C-4EFD-8020-67D146A850E0}, pid=14
                    var pkey = GM.CreateVariable(20);
                    var pkb  = pkey.toBuffer();
                    pkb[0]=0x4E;pkb[1]=0x25;pkb[2]=0x5C;pkb[3]=0xA4; // Data1 A45C254E (LE)
                    pkb[4]=0x1C;pkb[5]=0xDF;                           // Data2 DF1C (LE)
                    pkb[6]=0xFD;pkb[7]=0x4E;                           // Data3 4EFD (LE)
                    pkb[8]=0x80;pkb[9]=0x20;pkb[10]=0x67;pkb[11]=0xD1; // Data4
                    pkb[12]=0x46;pkb[13]=0xA8;pkb[14]=0x50;pkb[15]=0xE0;
                    pkb[16]=0x0E;pkb[17]=0x00;pkb[18]=0x00;pkb[19]=0x00; // pid=14

                    var pv = GM.CreateVariable(24); // PROPVARIANT
                    if (pProp.funcs.GetValue(pProp, pkey, pv).Val === 0) {
                        var pvBuf = pv.toBuffer();
                        if (pvBuf.readUInt16LE(0) === 0x1F) { // VT_LPWSTR
                            // pv.Deref(8) reads the LPWSTR pointer stored at offset 8 of PROPVARIANT.
                            try {
                                var sName = _readWStr(GM, k32, pv.Deref(8), 512);
                                if (sName) name = sName;
                            } catch (_pve) { /* Deref(8) may not be supported on all builds */ }
                        }
                    }
                }
            } catch (_ne) {}

            var isDefault = defId && devId === defId;
            result.push({ idx: i, name: name + (isDefault ? ' ★' : '') });
        }
    } catch (_ge) {}
    return result;
}

// Open a render endpoint: devIdx<0 = system default, devIdx>=0 = IMMDeviceCollection index.
function _openDevice(GM, _COM, devIdx) {
    var pEn = _makeEnumerator(GM, _COM);
    if (devIdx < 0) {
        var pDefPtr = GM.CreatePointer();
        var hr = pEn.funcs.GetDefaultAudioEndpoint(pEn, 0, 0, pDefPtr).Val;
        if (hr !== 0) throw new Error('GDE:0x' + (hr >>> 0).toString(16));
        return pDefPtr.Deref();
    }
    var pCollPtr = GM.CreatePointer();
    var hr2 = pEn.funcs.EnumAudioEndpoints(pEn, 0, 1, pCollPtr).Val;
    if (hr2 !== 0) throw new Error('EnumEP:0x' + (hr2 >>> 0).toString(16));
    var pColl = pCollPtr.Deref();
    pColl.funcs = _COM.marshalFunctions(pColl, [
        'QueryInterface','AddRef','Release','GetCount','Item'
    ]);
    var pDevPtr = GM.CreatePointer();
    var hr3 = pColl.funcs.Item(pColl, devIdx, pDevPtr).Val;
    if (hr3 !== 0) throw new Error('Item(' + devIdx + '):0x' + (hr3 >>> 0).toString(16));
    return pDevPtr.Deref();
}

// ── Tunnel command handler ────────────────────────────────────────────────────

obj.ontunneldata = function (data, tunnel) {
    var cmd = (typeof data === 'string') ? data.trim() : null;
    if (!cmd) return;

    if (cmd === 'listDevices') {
        try {
            var GM   = require('_GenericMarshal');
            var _COM = require('win-com');
            var k32  = GM.CreateNativeProxy('kernel32.dll');
            k32.CreateMethod('RtlMoveMemory');
            var devices = _getDevices(GM, _COM, k32);
            try { tunnel.write('DEVICES:' + JSON.stringify(devices)); } catch (_w) {}
        } catch (_lde) {
            try { tunnel.write('DEVICES:[]'); } catch (_w) {}
        }
        return;
    }

    if (cmd === 'start' || cmd.indexOf('start:') === 0) {
        var devIdx = -1;
        if (cmd.indexOf('start:') === 0) {
            var parsed = parseInt(cmd.substring(6));
            if (!isNaN(parsed)) devIdx = parsed;
        }
        obj._start(tunnel, devIdx);
        return;
    }

    if (cmd === 'stop')         { obj._stop(); return; }
    if (cmd === 'ping')         { return; }          // keepalive — no reply needed
    if (cmd === 'getTranscript'){ return; }           // transcript handled by inline fallback only
};

// ── Start capture ─────────────────────────────────────────────────────────────

obj._start = function (tunnel, devIdx) {
    if (devIdx === undefined || devIdx === null) devIdx = -1;
    obj._stop();

    try {
        var GM, _COM, k32, pAC, pCC, nCh, nSR, nBPS;

        if (_cache && _cacheDevIdx === devIdx) {
            // Fast path: reuse cached WASAPI client for the same device.
            GM = _cache.GM; k32 = _cache.k32;
            pAC = _cache.pAC; pCC = _cache.pCC;
            nCh = _cache.ch; nSR = _cache.sr; nBPS = _cache.bps;
            try { pAC.funcs.Stop(pAC); }  catch (_) {}
            try { pAC.funcs.Reset(pAC); } catch (_) {}
        } else {
            // Full init for new or changed device.
            _cache = null; _cacheDevIdx = -1;
            GM   = require('_GenericMarshal');
            _COM = require('win-com');
            k32  = GM.CreateNativeProxy('kernel32.dll');
            k32.CreateMethod('RtlMoveMemory');

            var _pDv = _openDevice(GM, _COM, devIdx);
            _pDv.funcs = _COM.marshalFunctions(_pDv, [
                'QueryInterface','AddRef','Release',
                'Activate','OpenPropertyStore','GetId','GetState'
            ]);

            // IAudioClient
            var _iAC = _COM.IIDFromString('{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}');
            var _pv  = GM.CreateVariable(16);
            var _pAP = GM.CreatePointer();
            var _hr  = _pDv.funcs.Activate(_pDv, _iAC, 23, _pv, _pAP).Val;
            if (_hr !== 0) throw new Error('Act:0x' + (_hr >>> 0).toString(16));
            pAC = _pAP.Deref();
            pAC.funcs = _COM.marshalFunctions(pAC, [
                'QueryInterface','AddRef','Release',
                'Initialize','GetBufferSize','GetStreamLatency','GetCurrentPadding',
                'IsFormatSupported','GetMixFormat','GetDevicePeriod',
                'Start','Stop','Reset','SetEventHandle','GetService'
            ]);

            // Read mix format (sample rate, channels, bit depth).
            var _pWP = GM.CreatePointer();
            _hr = pAC.funcs.GetMixFormat(pAC, _pWP).Val;
            if (_hr !== 0) throw new Error('GMF:0x' + (_hr >>> 0).toString(16));
            var _pW = _pWP.Deref();
            nCh = 2; nSR = 48000; nBPS = 32;
            try {
                var _wb = GM.CreateVariable(40);
                k32.RtlMoveMemory(_wb, _pW, 40);
                var _wr = _wb.toBuffer();
                var _wT = _wr.readUInt16LE(0);
                nCh  = _wr.readUInt16LE(2);
                nSR  = _wr.readUInt32LE(4);
                nBPS = _wr.readUInt16LE(14);
                if (_wT === 0xFFFE && _wr.readUInt16LE(16) >= 22) {
                    if (_wr.readUInt32LE(24) === 3) nBPS = 32;
                } else if (_wT === 3) { nBPS = 32; }
            } catch (_fe) {}
            if (nCh < 1 || nCh > 32 || nSR < 8000 || nSR > 192000 ||
                (nBPS !== 16 && nBPS !== 32)) { nCh = 2; nSR = 48000; nBPS = 32; }

            // Initialize for loopback capture (shared mode, AUDCLNT_STREAMFLAGS_LOOPBACK).
            var _sg = GM.CreateVariable(16);
            _hr = pAC.funcs.Initialize(pAC, 0, 0x00020000, 0, 0, _pW, _sg).Val;
            // 0x88890004 = AUDCLNT_E_DEVICE_IN_USE: another app holds the device in
            // exclusive mode (bypasses the shared audio engine — loopback sees nothing).
            // Pre-blocker below normally prevents this, but if LDB was already running
            // before this module loaded, it may have beaten us.
            if ((_hr >>> 0) === 0x88890004) throw new Error('EXCLUSIVE');
            if (_hr !== 0) throw new Error('Init:0x' + (_hr >>> 0).toString(16));

            // IAudioCaptureClient
            var _iCC = _COM.IIDFromString('{C8ADBD64-E71E-48A0-A4DE-185C395CD317}');
            var _pCP = GM.CreatePointer();
            _hr = pAC.funcs.GetService(pAC, _iCC, _pCP).Val;
            if (_hr !== 0) throw new Error('GS:0x' + (_hr >>> 0).toString(16));
            pCC = _pCP.Deref();
            pCC.funcs = _COM.marshalFunctions(pCC, [
                'QueryInterface','AddRef','Release',
                'GetBuffer','ReleaseBuffer','GetNextPacketSize'
            ]);

            _cache = { GM: GM, k32: k32, pAC: pAC, pCC: pCC, ch: nCh, sr: nSR, bps: nBPS };
            _cacheDevIdx = devIdx;
        }

        var hr = pAC.funcs.Start(pAC).Val;
        if (hr !== 0) throw new Error('Str:0x' + (hr >>> 0).toString(16));

        var _bpf = nCh * (nBPS >> 3);

        // Drain any pre-buffered frames before streaming.
        var pktV = GM.CreateVariable(4), ppD = GM.CreatePointer();
        var nFrV = GM.CreateVariable(4), flV = GM.CreateVariable(4), posV = GM.CreateVariable(8);
        try {
            for (var _fi = 0; _fi < 500; _fi++) {
                if (pCC.funcs.GetNextPacketSize(pCC, pktV).Val !== 0) break;
                if (pktV.toBuffer().readUInt32LE() === 0) break;
                if (pCC.funcs.GetBuffer(pCC, ppD, nFrV, flV, posV, posV).Val !== 0) break;
                pCC.funcs.ReleaseBuffer(pCC, nFrV.toBuffer().readUInt32LE());
            }
        } catch (_fx) {}

        // AUDIO header: always report :16 because we convert Float32→Int16 before sending.
        tunnel.write('AUDIO:' + nSR + ':' + nCh + ':16');

        // 10ms streaming loop — drain up to 32 WASAPI packets per tick so a stalled
        // tick (GC pause, another tunnel busy, etc.) catches up immediately instead
        // of building a backlog that shows up as crackle/dropouts a moment later.
        var _interval = setInterval(function () {
            if (!_active) return;
            try {
                // Coalesce every packet drained this tick into one write instead of
                // one tunnel.write() per WASAPI packet -- fewer, bigger relay frames
                // deliver more evenly to the browser and reduce the tiny stalls/pauses
                // that come from bursty one-packet-at-a-time delivery.
                var _tickChunks = [];
                for (var _pi = 0; _pi < 32; _pi++) {
                    if (pCC.funcs.GetNextPacketSize(pCC, pktV).Val !== 0) break;
                    if (pktV.toBuffer().readUInt32LE() === 0) break;
                    if (pCC.funcs.GetBuffer(pCC, ppD, nFrV, flV, posV, posV).Val !== 0) break;
                    var nF = nFrV.toBuffer().readUInt32LE();
                    var fl = flV.toBuffer().readUInt32LE();
                    var sz = nF * _bpf;
                    if (sz > 0 && sz <= 65536 && (fl & 2) === 0) {
                        var pcmBuf = GM.CreateVariable(sz);
                        k32.RtlMoveMemory(pcmBuf, ppD.Deref(), sz);
                        if (nBPS === 32) {
                            // Float32→Int16 in-place: write at i*2 is always behind read at i*4.
                            var _fb = pcmBuf.toBuffer(), _ns = sz >> 2;
                            for (var _si = 0; _si < _ns; _si++) {
                                var _u = _fb.readUInt32LE(_si * 4), _iv = 0, _e = (_u >>> 23) & 0xFF;
                                if (_e > 0 && _e < 255) {
                                    var _m = (_u & 0x7FFFFF) | 0x800000;
                                    var _f = _m * Math.pow(2, _e - 150);
                                    if (_u >>> 31) _f = -_f;
                                    // Round to nearest, not truncate-toward-zero -- truncation
                                    // biases every sample slightly and adds audible quantization noise.
                                    _iv = _f >= 1 ? 32767 : _f <= -1 ? -32768 : Math.round(_f * 32767);
                                }
                                _fb[_si * 2]     = _iv & 0xFF;
                                _fb[_si * 2 + 1] = (_iv >> 8) & 0xFF;
                            }
                            _tickChunks.push(_fb.slice(0, _ns * 2));
                        } else {
                            _tickChunks.push(pcmBuf.toBuffer());
                        }
                    }
                    pCC.funcs.ReleaseBuffer(pCC, nF);
                }
                if (_tickChunks.length === 1) {
                    tunnel.write(_tickChunks[0]);
                } else if (_tickChunks.length > 1) {
                    tunnel.write(Buffer.concat(_tickChunks));
                }
            } catch (_x) {}
        }, 10);

        _active = { interval: _interval, pAC: pAC };

    } catch (_err) {
        _cache = null; _cacheDevIdx = -1;
        var _em = String(_err.message || _err);
        // 0x800706ba = RPC_S_SERVER_UNAVAILABLE = Windows Audio service not running.
        if (_em.indexOf('800706ba') >= 0 && !obj._svcTried) {
            obj._svcTried = true;
            try { tunnel.write('WAIT'); } catch (_wx) {}
            try {
                var _gm2 = require('_GenericMarshal');
                var _adv = _gm2.CreateNativeProxy('advapi32.dll');
                _adv.CreateMethod('OpenSCManagerA');
                _adv.CreateMethod('OpenServiceA');
                _adv.CreateMethod('StartServiceA');
                _adv.CreateMethod('CloseServiceHandle');
                var _doStart = function (svcName) {
                    try {
                        var _nb = _gm2.CreateVariable(svcName.length + 1);
                        var _bb = _nb.toBuffer();
                        for (var _ii = 0; _ii < svcName.length; _ii++) _bb[_ii] = svcName.charCodeAt(_ii);
                        var _scm = _adv.OpenSCManagerA(0, 0, 1);
                        var _sv  = _adv.OpenServiceA(_scm, _nb, 16);
                        _adv.StartServiceA(_sv, 0, 0);
                        _adv.CloseServiceHandle(_sv);
                        _adv.CloseServiceHandle(_scm);
                    } catch (_x) {}
                };
                _doStart('audiosrv');
                _doStart('AudioEndpointBuilder');
            } catch (_se) {}
            setTimeout(function () { obj._svcTried = false; obj._start(tunnel, devIdx); }, 4000);
        } else if (_em === 'EXCLUSIVE') {
            // Device is in exclusive mode — send a dedicated protocol message so the
            // browser can show a clear actionable message instead of a generic error.
            try { tunnel.write('EXCLUSIVE'); } catch (_x) {}
        } else {
            try { tunnel.write('ERROR:' + _em.substr(0, 120)); } catch (_x) {}
        }
    }
};

// ── Stop capture ──────────────────────────────────────────────────────────────

obj._stop = function () {
    if (!_active) return;
    var a = _active;
    _active = null;
    try { clearInterval(a.interval); } catch (_x) {}
    try { a.pAC.funcs.Stop(a.pAC); }  catch (_x) {}
};

// ── Exclusive-mode pre-blocker ────────────────────────────────────────────────
// Windows will not grant exclusive mode to any app while a shared-mode
// IAudioClient already holds the device.  By opening one here at module-load
// time (which happens when the first KVM tunnel arrives), we block LDB (and
// any other app) from taking exclusive mode from that point forward.
//
// If LDB is ALREADY running in exclusive mode when this module loads, the
// Initialize call below will fail (silently — the blocker just won't exist).
// In that case: in Windows Sound settings on the remote machine go to the
// playback device → Properties → Advanced → uncheck "Allow applications to
// take exclusive control of this device", then restart LDB.  Next time the
// module loads it will successfully pre-block.
var _blocker = null;
(function () {
    try {
        var _bGM  = require('_GenericMarshal');
        var _bCOM = require('win-com');
        var _bEn  = _makeEnumerator(_bGM, _bCOM);
        var _bDP  = _bGM.CreatePointer();
        if (_bEn.funcs.GetDefaultAudioEndpoint(_bEn, 0, 0, _bDP).Val !== 0) return;
        var _bDv  = _bDP.Deref();
        _bDv.funcs = _bCOM.marshalFunctions(_bDv, [
            'QueryInterface','AddRef','Release',
            'Activate','OpenPropertyStore','GetId','GetState'
        ]);
        var _bIAC = _bCOM.IIDFromString('{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}');
        var _bPv  = _bGM.CreateVariable(16);
        var _bAP  = _bGM.CreatePointer();
        if (_bDv.funcs.Activate(_bDv, _bIAC, 23, _bPv, _bAP).Val !== 0) return;
        var _bAC  = _bAP.Deref();
        _bAC.funcs = _bCOM.marshalFunctions(_bAC, [
            'QueryInterface','AddRef','Release',
            'Initialize','GetBufferSize','GetStreamLatency','GetCurrentPadding',
            'IsFormatSupported','GetMixFormat','GetDevicePeriod',
            'Start','Stop','Reset','SetEventHandle','GetService'
        ]);
        var _bWP  = _bGM.CreatePointer();
        if (_bAC.funcs.GetMixFormat(_bAC, _bWP).Val !== 0) return;
        var _bSg  = _bGM.CreateVariable(16);
        // Shared mode, no loopback flag — just holds the device to block exclusive mode.
        // Multiple shared-mode clients on the same device are always allowed; this
        // does not interfere with our own loopback capture client.
        if (_bAC.funcs.Initialize(_bAC, 0, 0, 0, 0, _bWP.Deref(), _bSg).Val === 0) {
            _blocker = { GM: _bGM, pAC: _bAC }; // keep ref alive so GC doesn't collect
        }
    } catch (_be) {}
})();

obj._v = 5; // version marker — meshcore.js checks _v >= 3 to prefer module over inline fallback
module.exports = obj;
