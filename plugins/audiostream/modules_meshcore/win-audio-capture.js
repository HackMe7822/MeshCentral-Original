'use strict';
/*
 * win-audio-capture.js  (MeshAgent module, auto-injected via win- prefix)
 *
 * TEST BUILD: generates a 440 Hz sine wave in pure JavaScript.
 * No subprocess, no WASAPI, no session boundary issues.
 * Purpose: confirm the entire pipeline works:
 *   agent JS timer -> Buffer -> tunnel.write -> relay -> browser ArrayBuffer -> Web Audio API
 * Once you hear the test tone, swap in the real WASAPI capture.
 */

var obj = {};
var _active = null;

// Called by meshcore.js for every data frame on protocol 201
obj.ontunneldata = function (data, tunnel) {
    var cmd = (typeof data === 'string') ? data.trim() : null;
    if      (cmd === 'start') { obj._startCapture(tunnel); }
    else if (cmd === 'stop')  { obj._stopCapture(); }
};

obj._startCapture = function (tunnel) {
    if (_active) obj._stopCapture();

    var sr   = 44100;
    var ch   = 2;
    var freq = 440;       // 440 Hz test tone

    // Send AUDIO: header as a text frame so browser knows sr/channels
    try { tunnel.write('AUDIO:' + sr + ':' + ch + ':16'); } catch (e) {}

    // Generate sine wave chunks every 50 ms
    var phase    = 0;
    var phaseInc = (2 * Math.PI * freq) / sr;
    var amp      = 10000;                       // ~30% max volume
    var frames   = Math.floor(sr / 20);         // 2205 frames @ 44100
    var bufSize  = frames * ch * 2;             // 2 bytes/sample × 2 ch

    var iid = setInterval(function () {
        if (!_active) { clearInterval(iid); return; }
        try {
            var buf = Buffer.alloc(bufSize);
            for (var i = 0; i < frames; i++) {
                var s = Math.round(Math.sin(phase) * amp);
                if (s >  32767)  s =  32767;
                if (s < -32768)  s = -32768;
                phase += phaseInc;
                // Int16 LE written manually (avoids any writeInt16LE compat concerns)
                buf[i * 4]     = s & 0xFF;
                buf[i * 4 + 1] = (s >> 8) & 0xFF;
                buf[i * 4 + 2] = s & 0xFF;          // right ch same as left
                buf[i * 4 + 3] = (s >> 8) & 0xFF;
            }
            tunnel.write(buf);  // binary frame → relay → browser ArrayBuffer
        } catch (e) {
            obj._stopCapture();
        }
    }, 50);

    _active = { interval: iid, tunnel: tunnel };
};

obj._stopCapture = function () {
    if (_active) {
        if (_active.interval) { try { clearInterval(_active.interval); } catch (e) {} }
        if (_active.proc)     { try { _active.proc.kill();             } catch (e) {} }
        _active = null;
    }
};

module.exports = obj;
