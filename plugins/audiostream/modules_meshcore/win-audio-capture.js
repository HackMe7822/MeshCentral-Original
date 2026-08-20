'use strict';
/*
 * win-audio-capture.js  (audiostream plugin – agent module) v6
 *
 * v6: capture moved out of this JS module entirely. Polling WASAPI via setInterval
 * on the agent's single JS thread meant any contention on that thread (KVM desktop
 * session, other tunnels, GC pauses) delayed a poll tick past WASAPI's internal
 * buffer window, permanently dropping samples -- audible as pauses/crackle,
 * worse whenever a KVM session was also active. Fixed by spawning a small native
 * helper (audiocap.exe, embedded below as base64, same pattern as the mesh_stt
 * subprocess used for captions) that captures on its own OS thread/process,
 * immune to the agent's JS event loop being busy, and pipes raw PCM to stdout.
 * This module just spawns it and relays stdout bytes to the tunnel.
 *
 * v4/v5 (device enumeration, exclusive-mode pre-blocker) unchanged below.
 */

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

// ── Native capture helper (audiocap.exe) ──────────────────────────────────────
// WASAPI loopback capture on its own OS process/thread -- see header comment.
// Embedded as base64 and written to a temp file on first use, same pattern the
// SAPI caption feature already uses for its mesh_stt subprocess.

var _AUDIOCAP_EXE_SIZE = 8704;
var _AUDIOCAP_B64 =
'TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAA4fug4AtAnNIbgBTM0hVGhpcyBwcm9ncmFtIGNhbm5vdCBiZSBydW4gaW4gRE9TIG1vZGUuDQ0KJAAAAAAAAABQRQAAZIYCAJEKh2oAAAAAAAAAAPAAIgALAgsAABoAAAAGAAAAAAAAAAAAAAAgAAAAAABAAQAAAAAgAAAAAgAABAAAAAAAAAAEAAAAAAAAAABgAAAAAgAAAAAAAAMAQIUAAEAAAAAAAABAAAAAAAAAAAAQAAAAAAAAIAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAABAAADgBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAABIAAAAAAAAAAAAAAAudGV4dAAAAFQZAAAAIAAAABoAAAACAAAAAAAAAAAAAAAAAAAgAABgLnJzcmMAAADgBAAAAEAAAAAGAAAAHAAAAAAAAAAAAAAAAAAAQAAAQC5yZWxvYwAAAAAAAABgAAAAAAAAACIAAAAAAAAAAAAAAAAAAEAAAEJIAAAAAgAFAFAlAAAEFAAAAQAAAAUAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABswBwCQBAAAAQAAEX4GAAAKFigBAAAGJn4BAAAECn4CAAAECxIAfgYAAAoXEgESAigCAAAGDQksHHIBAABwEgNyKQAAcCgHAAAKKAgAAApzCQAACnoIKAoAAAp0AwAAAhMEFRMFKAsAAAoTBhEGjmkXMQwRBheaEgUoDAAACiYRBRYvLhEEFhYSB28JAAAGDQk5mAAAAHItAABwEgNyKQAAcCgHAAAKKAgAAApzCQAACnoRBBYXEghvCAAABg0JLBxyYwAAcBIDcikAAHAoBwAACigIAAAKcwkAAAp6EQgRBRIHbxIAAAYNCSxCGo0BAAABEygRKBZyjwAAcKIRKBcRBYwKAAABohEoGHKbAABwohEoGRIDcikAAHAoBwAACqIRKCgNAAAKcwkAAAp6fgMAAAQTCREHEgkXfgYAAAoSCm8NAAAGDQksHHKlAABwEgNyKQAAcCgHAAAKKAgAAApzCQAACnoRCnQGAAACEwsRCxIMbxgAAAYNCSwccr0AAHASA3IpAABwKAcAAAooCAAACnMJAAAKehEMFigOAAAK0RMNEQwYKA4AAArREw4RDBooDwAAChMPEQwfDigOAAAK0RMQFhMREQ0g/v8AADMUEQwfGCgPAAAKExIREhn+ARMRKwgRDRkzAxcTESAAAAYAExMRCxYRExZqFmoRDH4GAAAKbxMAAAYNCSAEAImIMwty3QAAcHMJAAAKegksHHLxAABwEgNyKQAAcCgHAAAKKAgAAApzCQAACnp+BgAAChYWFCgDAAAGExQRCxEUbx0AAAYNCSwccg0BAHASA3IpAABwKAcAAAooCAAACnMJAAAKen4EAAAEExURCxIVEhZvHgAABg0JLBxyMQEAcBIDcikAAHAoBwAACigIAAAKcwkAAAp6ERZ0BwAAAhMXKBAAAAoTGB6NEQAAARMZEQ8oEQAAChEZFm8SAAAKEQ4oEwAAChEZGm8SAAAKHxAoEwAAChEZHG8SAAAKERgRGRYebxQAAAoRGG8VAAAKEQtvGgAABg0JLBxyTQEAcBIDcikAAHAoBwAACigIAAAKcwkAAAp6ERQg0AcAACgEAAAGJhEXEhpvIQAABiY4EAEAABEXEhsSHBIdEh4SH28fAAAGEyARIC3NERwWQ90AAAARHRhfOtQAAAARHBEOWhMhESEYWo0RAAABEyIRETmMAAAAFhMjK3wRGxEjGlooFgAACtAUAAABKBcAAAooGAAACqUUAAABEyQRJCIAAIA/LyERJCIAAIC/MRERJCIA/v9GWmwoGQAACmkrDCAAgP//KwUg/38AABMlESIRIxhaESUg/wAAAF/SnBEiESMYWhdYESUeYyD/AAAAX9KcESMXWBMjESMRIT97////KxoRGxEiFhEijmkRIREQHltaKBoAAAooGwAAChEYESIWESKOaW8UAAAKERhvFQAAChEXERxvIAAABiYRFxIabyEAAAYmERo66f7//zjI/v//EyYRJm8cAAAKEycRJ3JfAQBwG28dAAAKFjIHcnEBAHATJygeAAAKco0BAHARJygIAAAKbx8AAAoXKCAAAAreACpBHAAAAAAAAAAAAABPBAAATwQAAEAAAAAMAAAB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PgBhdWRpb2NhcC5leGUAUHJvZ3JhbQBJTU1EZXZpY2VFbnVtZXJhdG9yAElNTURldmljZQBJTU1EZXZpY2VDb2xsZWN0aW9uAElBdWRpb0NsaWVudABJQXVkaW9DYXB0dXJlQ2xpZW50AG1zY29ybGliAFN5c3RlbQBPYmplY3QAQ29Jbml0aWFsaXplRXgAR3VpZABDb0NyZWF0ZUluc3RhbmNlAENyZWF0ZUV2ZW50AFdhaXRGb3JTaW5nbGVPYmplY3QAQ0xTSURfTU1EZXZpY2VFbnVtZXJhdG9yAElJRF9JTU1EZXZpY2VFbnVtZXJhdG9yAElJRF9JQXVkaW9DbGllbnQASUlEX0lBdWRpb0NhcHR1cmVDbGllbnQATWFpbgAuY3RvcgBFbnVtQXVkaW9FbmRwb2ludHMAR2V0RGVmYXVsdEF1ZGlvRW5kcG9pbnQAR2V0RGV2aWNlAFJlZ2lzdGVyRW5kcG9pbnROb3RpZmljYXRpb25DYWxsYmFjawBVbnJlZ2lzdGVyRW5kcG9pbnROb3RpZmljYXRpb25DYWxsYmFjawBBY3RpdmF0ZQBPcGVuUHJvcGVydHlTdG9yZQBHZXRJZABHZXRTdGF0ZQBHZXRDb3VudABJdGVtAEluaXRpYWxpemUAR2V0QnVmZmVyU2l6ZQBHZXRTdHJlYW1MYXRlbmN5AEdldEN1cnJlbnRQYWRkaW5nAElzRm9ybWF0U3VwcG9ydGVkAEdldE1peEZvcm1hdABHZXREZXZpY2VQZXJpb2QAU3RhcnQAU3RvcABSZXNldABTZXRFdmVudEhhbmRsZQBHZXRTZXJ2aWNlAEdldEJ1ZmZlcgBSZWxlYXNlQnVmZmVyAEdldE5leHRQYWNrZXRTaXplAHB2UmVzZXJ2ZWQAZHdDb0luaXQAY2xzaWQAcFVua091dGVyAGR3Q2xzQ29udGV4dAByaWlkAHBwdgBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXMAT3V0QXR0cmlidXRlAGxwRXZlbnRBdHRyaWJ1dGVzAGJNYW51YWxSZXNldABiSW5pdGlhbFN0YXRlAGxwTmFtZQBoSGFuZGxlAGR3TWlsbGlzZWNvbmRzAGRhdGFGbG93AGR3U3RhdGVNYXNrAHBwRGV2aWNlcwByb2xlAHBwRGV2aWNlAHB3c3RySWQAcENsaWVudABpaWQAZHdDbHNDdHgAcEFjdGl2YXRpb25QYXJhbXMAcHBJbnRlcmZhY2UATWFyc2hhbEFzQXR0cmlidXRlAFVubWFuYWdlZFR5cGUAc3RnbUFjY2VzcwBwcFByb3BlcnRpZXMAcHBzdHJJZABwZHdTdGF0ZQBwY0RldmljZXMAbkRldmljZQBzaGFyZU1vZGUAc3RyZWFtRmxhZ3MAaG5zQnVmZmVyRHVyYXRpb24AaG5zUGVyaW9kaWNpdHkAcEZvcm1hdABhdWRpb1Nlc3Npb25HdWlkAHBOdW1CdWZmZXJGcmFtZXMAcGhuc0xhdGVuY3kAcE51bVBhZGRpbmdGcmFtZXMAcHBDbG9zZXN0TWF0Y2gAcHBEZXZpY2VGb3JtYXQAcGhuc0RlZmF1bHREZXZpY2VQZXJpb2QAcGhuc01pbmltdW1EZXZpY2VQZXJpb2QAZXZlbnRIYW5kbGUAcHBEYXRhAHBOdW1GcmFtZXNUb1JlYWQAcGR3RmxhZ3MAcHU2NERldmljZVBvc2l0aW9uAHB1NjRRUENQb3NpdGlvbgBudW1GcmFtZXNXcml0dGVuAHBOdW1GcmFtZXNJbk5leHRQYWNrZXQAU3lzdGVtLlJ1bnRpbWUuQ29tcGlsZXJTZXJ2aWNlcwBDb21waWxhdGlvblJlbGF4YXRpb25zQXR0cmlidXRlAFJ1bnRpbWVDb21wYXRpYmlsaXR5QXR0cmlidXRlAGF1ZGlvY2FwAERsbEltcG9ydEF0dHJpYnV0ZQBvbGUzMi5kbGwAa2VybmVsMzIuZGxsAEludFB0cgBaZXJvAEludDMyAFRvU3RyaW5nAFN0cmluZwBDb25jYXQARXhjZXB0aW9uAE1hcnNoYWwAR2V0T2JqZWN0Rm9ySVVua25vd24ARW52aXJvbm1lbnQAR2V0Q29tbWFuZExpbmVBcmdzAFRyeVBhcnNlAFJlYWRJbnQxNgBSZWFkSW50MzIAQ29uc29sZQBTeXN0ZW0uSU8AU3RyZWFtAE9wZW5TdGFuZGFyZE91dHB1dABCeXRlAEJpdENvbnZlcnRlcgBHZXRCeXRlcwBBcnJheQBDb3B5VG8AV3JpdGUARmx1c2gAQWRkAFNpbmdsZQBUeXBlAFJ1bnRpbWVUeXBlSGFuZGxlAEdldFR5cGVGcm9tSGFuZGxlAFB0clRvU3RydWN0dXJlAE1hdGgAUm91bmQATWluAENvcHkAZ2V0X01lc3NhZ2UAU3RyaW5nQ29tcGFyaXNvbgBJbmRleE9mAFRleHRXcml0ZXIAZ2V0X0Vycm9yAFdyaXRlTGluZQBFeGl0AC5jY3RvcgBDb21JbXBvcnRBdHRyaWJ1dGUAR3VpZEF0dHJpYnV0ZQBJbnRlcmZhY2VUeXBlQXR0cmlidXRlAENvbUludGVyZmFjZVR5cGUAAAAnQwBvAEMAcgBlAGEAdABlAEkAbgBzAHQAYQBuAGMAZQA6ADAAeAAAA1gAADVHAGUAdABEAGUAZgBhAHUAbAB0AEEAdQBkAGkAbwBFAG4AZABwAG8AaQBuAHQAOgAwAHgAACtFAG4AdQBtAEEAdQBkAGkAbwBFAG4AZABwAG8AaQBuAHQAcwA6ADAAeAAAC0kAdABlAG0AKAAACSkAOgAwAHgAABdBAGMAdABpAHYAYQB0AGUAOgAwAHgAAB9HAGUAdABNAGkAeABGAG8AcgBtAGEAdAA6ADAAeAAAE0UAWABDAEwAVQBTAEkAVgBFAAAbSQBuAGkAdABpAGEAbABpAHoAZQA6ADAAeAAAI1MAZQB0AEUAdgBlAG4AdABIAGEAbgBkAGwAZQA6ADAAeAAAG0cAZQB0AFMAZQByAHYAaQBjAGUAOgAwAHgAABFTAHQAYQByAHQAOgAwAHgAABE4ADAAMAA3ADAANgBCAEEAABtBAFUARABJAE8AUwBWAEMAXwBEAE8AVwBOAAAJRQBSAFIAOgAASUIAQwBEAEUAMAAzADkANQAtAEUANQAyAEYALQA0ADYANwBDAC0AOABFADMARAAtAEMANAA1ADcAOQAyADkAMQA2ADkAMgBFAAFJQQA5ADUANgA2ADQARAAyAC0AOQA2ADEANAAtADQARgAzADUALQBBADcANAA2AC0ARABFADgARABCADYAMwA2ADEANwBFADYAAUkxAEMAQgA5AEEARAA0AEMALQBEAEIARgBBAC0ANABDADMAMgAtAEIAMQA3ADgALQBDADIARgA1ADYAOABBADcAMAAzAEIAMgABSUMAOABBAEQAQgBEADYANAAtAEUANwAxAEUALQA0ADgAQQAwAC0AQQA0AEQARQAtADEAOAA1AEMAMwA5ADUAQwBEADMAMQA3AAEA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';

function _startAudioService() {
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
}

function _ensureExe() {
    var fs = require('fs');
    var tmpDir = (process.env.TEMP || process.env.TMP || (process.env.windir || 'C:\\Windows') + '\\Temp');
    var path = tmpDir + '\\mesh_audiocap_v1.exe';
    var needWrite = true;
    try { if (fs.statSync(path).size === _AUDIOCAP_EXE_SIZE) needWrite = false; } catch (_e) {}
    if (needWrite) {
        try { fs.writeFileSync(path, Buffer.from(_AUDIOCAP_B64, 'base64')); } catch (_we) {}
    }
    return path;
}

// ── Start capture ─────────────────────────────────────────────────────────────

obj._start = function (tunnel, devIdx) {
    if (devIdx === undefined || devIdx === null) devIdx = -1;
    obj._stop();

    try {
        var cp = require('child_process');
        var exePath = _ensureExe();
        var args = devIdx >= 0 ? [String(devIdx)] : [];
        var child = cp.spawn(exePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        var headerParsed = false;
        var headerBuf = Buffer.alloc(0);
        var stopped = false;
        var errBuf = '';

        var procState = {
            stop: function () {
                stopped = true;
                try { child.kill(); } catch (_k) {}
            }
        };
        _active = procState;

        child.stdout.on('data', function (chunk) {
            if (stopped) return;
            if (!headerParsed) {
                headerBuf = Buffer.concat([headerBuf, chunk]);
                if (headerBuf.length < 8) return;
                var sr  = headerBuf.readUInt32LE(0);
                var ch  = headerBuf.readUInt16LE(4);
                var bps = headerBuf.readUInt16LE(6);
                headerParsed = true;
                try { tunnel.write('AUDIO:' + sr + ':' + ch + ':' + bps); } catch (_w) {}
                var rest = headerBuf.slice(8);
                headerBuf = null;
                if (rest.length > 0) { try { tunnel.write(rest); } catch (_w2) {} }
                return;
            }
            try { tunnel.write(chunk); } catch (_w3) {}
        });

        child.stderr.on('data', function (d) { errBuf += d.toString(); });

        child.on('exit', function (code) {
            if (_active !== procState) return; // superseded by a newer start/stop
            _active = null;
            if (stopped) return; // intentional stop -- no error to report
            var msg = errBuf.trim();
            if (msg.indexOf('ERR:EXCLUSIVE') >= 0) {
                // Device is in exclusive mode — dedicated protocol message so the
                // browser can show a clear actionable message instead of a generic error.
                try { tunnel.write('EXCLUSIVE'); } catch (_x) {}
            } else if (msg.indexOf('ERR:AUDIOSVC_DOWN') >= 0 && !obj._svcTried) {
                // Windows Audio service not running (common on Server VMs). Start it and retry once.
                obj._svcTried = true;
                try { tunnel.write('WAIT'); } catch (_wx) {}
                _startAudioService();
                setTimeout(function () { obj._svcTried = false; obj._start(tunnel, devIdx); }, 4000);
            } else {
                var shortMsg = msg.replace(/^ERR:/, '') || ('exit code ' + code);
                try { tunnel.write('ERROR:' + shortMsg.substr(0, 120)); } catch (_x) {}
            }
        });

    } catch (_err) {
        try { tunnel.write('ERROR:' + String(_err.message || _err).substr(0, 120)); } catch (_x) {}
    }
};

// ── Stop capture ──────────────────────────────────────────────────────────────

obj._stop = function () {
    if (!_active) return;
    var a = _active;
    _active = null;
    try { a.stop(); } catch (_x) {}
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

obj._v = 6; // version marker — meshcore.js checks _v >= 3 to prefer module over inline fallback
module.exports = obj;
