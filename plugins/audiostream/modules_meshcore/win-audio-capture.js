'use strict';
/*
 * win-audio-capture.js  (audiostream plugin – agent module)
 *
 * Direct WASAPI loopback via _GenericMarshal + win-com.
 * No PowerShell, no C#, no temp files, no 30-second compile delay.
 *
 * First capture: ~400ms WASAPI init. Subsequent: instant (client cached).
 * Wire format: AUDIO:<sr>:<ch>:16 header, then raw Int16-LE PCM chunks.
 */

var _cache  = null;   // reusable WASAPI client across reconnects
var _active = null;   // current session { interval, pAC }

var obj = {};

obj.ontunneldata = function (data, tunnel) {
    var cmd = (typeof data === 'string') ? data.trim() : null;
    if      (cmd === 'start') { obj._start(tunnel); }
    else if (cmd === 'stop')  { obj._stop(); }
};

obj._start = function (tunnel) {
    obj._stop();   // clean up any previous session first

    try {
        var GM, k32, pAC, pCC, nCh, nSR, nBPS;

        if (_cache) {
            // Fast path: reuse initialized WASAPI client (Stop+Reset then restart)
            GM = _cache.GM; k32 = _cache.k32;
            pAC = _cache.pAC; pCC = _cache.pCC;
            nCh = _cache.ch; nSR = _cache.sr; nBPS = _cache.bps;
            try { pAC.funcs.Stop(pAC); }  catch (_) {}
            try { pAC.funcs.Reset(pAC); } catch (_) {}
        } else {
            // First time: full WASAPI initialisation
            GM  = require('_GenericMarshal');
            var _COM = require('win-com');
            k32 = GM.CreateNativeProxy('kernel32.dll');
            k32.CreateMethod('RtlMoveMemory');

            // IMMDeviceEnumerator
            var _pEn = _COM.createInstance(
                _COM.CLSIDFromString('{BCDE0395-E52F-467C-8E3D-C4579291692E}'),
                _COM.IID_IUnknown
            );
            _pEn.funcs = _COM.marshalFunctions(_pEn, [
                'QueryInterface','AddRef','Release',
                'EnumAudioEndpoints','GetDefaultAudioEndpoint','GetDevice',
                'RegisterEndpointNotificationCallback','UnregisterEndpointNotificationCallback'
            ]);

            // Default render endpoint
            var _pDP = GM.CreatePointer();
            var _hr  = _pEn.funcs.GetDefaultAudioEndpoint(_pEn, 0, 0, _pDP).Val;
            if (_hr !== 0) throw new Error('GDE:0x' + (_hr >>> 0).toString(16));
            var _pDv = _pDP.Deref();
            _pDv.funcs = _COM.marshalFunctions(_pDv, [
                'QueryInterface','AddRef','Release',
                'Activate','OpenPropertyStore','GetId','GetState'
            ]);

            // IAudioClient
            var _iAC = _COM.IIDFromString('{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}');
            var _pv  = GM.CreateVariable(16);
            var _pAP = GM.CreatePointer();
            _hr = _pDv.funcs.Activate(_pDv, _iAC, 23, _pv, _pAP).Val;
            if (_hr !== 0) throw new Error('Act:0x' + (_hr >>> 0).toString(16));
            pAC = _pAP.Deref();
            pAC.funcs = _COM.marshalFunctions(pAC, [
                'QueryInterface','AddRef','Release',
                'Initialize','GetBufferSize','GetStreamLatency','GetCurrentPadding',
                'IsFormatSupported','GetMixFormat','GetDevicePeriod',
                'Start','Stop','Reset','SetEventHandle','GetService'
            ]);

            // Read mix format (nCh, nSR, nBPS)
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
                } else if (_wT === 3) {
                    nBPS = 32;
                }
            } catch (_fe) {}
            if (nCh < 1 || nCh > 32 || nSR < 8000 || nSR > 192000 ||
                (nBPS !== 16 && nBPS !== 32)) {
                nCh = 2; nSR = 48000; nBPS = 32;
            }

            // Initialise IAudioClient (loopback, shared mode, 0 = OS-chosen buffer)
            var _sg = GM.CreateVariable(16);
            _hr = pAC.funcs.Initialize(pAC, 0, 0x00020000, 0, 0, _pW, _sg).Val;
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
        }

        // Start capture
        var hr = pAC.funcs.Start(pAC).Val;
        if (hr !== 0) throw new Error('Str:0x' + (hr >>> 0).toString(16));

        var _bpf = nCh * (nBPS >> 3);

        // Drain any pre-buffered frames before streaming
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

        // Send AUDIO header (report :16 because we convert Float32→Int16 before sending)
        tunnel.write('AUDIO:' + nSR + ':' + nCh + ':' + (nBPS === 32 ? 16 : nBPS));

        // Streaming loop — 10ms tick, drain up to 8 WASAPI packets per tick
        var _interval = setInterval(function () {
            if (!_active) return;
            try {
                for (var _pi = 0; _pi < 8; _pi++) {
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
                            // Float32→Int16 in-place conversion
                            // Safe: write offset (i*2) is always <= read offset (i*4)
                            var _fb = pcmBuf.toBuffer(), _ns = sz >> 2;
                            for (var _si = 0; _si < _ns; _si++) {
                                var _u = _fb.readUInt32LE(_si * 4), _iv = 0, _e = (_u >>> 23) & 0xFF;
                                if (_e > 0 && _e < 255) {
                                    var _m = (_u & 0x7FFFFF) | 0x800000;
                                    var _f = _m * Math.pow(2, _e - 150);
                                    if (_u >>> 31) _f = -_f;
                                    _iv = _f >= 1 ? 32767 : _f <= -1 ? -32768 : (_f * 32767) | 0;
                                }
                                _fb[_si * 2]     = _iv & 0xFF;
                                _fb[_si * 2 + 1] = (_iv >> 8) & 0xFF;
                            }
                            tunnel.write(_fb.slice(0, _ns * 2));
                        } else {
                            tunnel.write(pcmBuf.toBuffer());
                        }
                    }
                    pCC.funcs.ReleaseBuffer(pCC, nF);
                }
            } catch (_x) {}
        }, 10);

        _active = { interval: _interval, pAC: pAC };

    } catch (_err) {
        _cache = null;
        var _em = String(_err.message || _err);
        // 0x800706ba = RPC_S_SERVER_UNAVAILABLE = Windows Audio service (audiosrv) not running.
        // Common on Windows Server VMs. Auto-start via SCM and retry once.
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
                        var _scm = _adv.OpenSCManagerA(0, 0, 1); // SC_MANAGER_CONNECT
                        var _sv  = _adv.OpenServiceA(_scm, _nb, 16); // SERVICE_START
                        _adv.StartServiceA(_sv, 0, 0);
                        _adv.CloseServiceHandle(_sv);
                        _adv.CloseServiceHandle(_scm);
                    } catch (_x) {}
                };
                _doStart('audiosrv');
                _doStart('AudioEndpointBuilder');
            } catch (_se) {}
            // Retry after 4 s — enough time for both services to start
            setTimeout(function () { obj._svcTried = false; obj._start(tunnel); }, 4000);
        } else {
            try { tunnel.write('ERROR:' + _em.substr(0, 120)); } catch (_x) {}
        }
    }
};

obj._stop = function () {
    if (!_active) return;
    var a = _active;
    _active = null;
    try { clearInterval(a.interval); } catch (_x) {}
    try { a.pAC.funcs.Stop(a.pAC); }  catch (_x) {}
};

obj._v = 2; // version marker — meshcore.js checks this to prefer module over inline fallback
module.exports = obj;
