'use strict';

/*
 * audiostream.js — Creations IT MeshCentral Audio Stream Plugin (server-side)
 *
 * Exports browser-side functions via the MeshCentral plugin export system.
 * The win-audio-capture.js module in modules_meshcore/ is auto-injected into
 * Windows agents by pluginHandler.js (win-* prefix → windows-amt core only).
 *
 * Protocol 201 tunnel flow:
 *   Browser → meshrelay.ashx (browser=1) ← [relay] → meshrelay.ashx ← Agent
 *   Browser sends: '201' (protocol set), then 'start' / 'stop'
 *   Agent sends:   binary PCM (16-bit, stereo, native sample rate)
 */

module.exports.audiostream = function (pluginHandler) {
    var obj = {};
    obj.pluginHandler = pluginHandler;

    // ── Server-side lifecycle ──────────────────────────────────────────────────

    obj.server_startup = function () {
        // nothing needed at startup
    };

    // ── Browser-side exports ───────────────────────────────────────────────────
    // Functions listed here are .toString()-ed and shipped to the browser via
    // /pluginHandler.js so they run client-side. They have access to all
    // MeshCentral browser globals: meshserver, currentNode, pluginHandler, etc.

    obj.exports = ['onWebUIStartupEnd'];

    // Runs in browser once on page load.
    obj.onWebUIStartupEnd = function () {

        // ── Register device panel tab ──────────────────────────────────────────
        function registerAudioTab() {
            if (!document.getElementById('p19headers')) return false;
            try {
                pluginHandler.registerPluginTab({ tabId: 'audiostreamtab', tabTitle: 'Audio' });
            } catch (e) { return false; }
            document.getElementById('audiostreamtab').innerHTML =
                '<div style="padding:14px 18px;">' +
                '<div style="margin-bottom:12px;font-weight:600;font-size:14px;">System Audio Monitor</div>' +
                '<div style="margin-bottom:10px;color:#888;font-size:12px;">Streams all audio playing on the remote device to your browser.</div>' +
                '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<button id="audioStartBtn" onclick="audioPlugin_start()" style="padding:6px 16px;cursor:pointer;">&#9654; Listen</button>' +
                '<button id="audioStopBtn" onclick="audioPlugin_stop()" style="padding:6px 16px;cursor:pointer;" disabled>&#9646;&#9646; Stop</button>' +
                '<label style="font-size:12px;">Volume</label>' +
                '<input type="range" id="audioVolumeSlider" min="0" max="1" step="0.05" value="0.8" ' +
                '    oninput="audioPlugin_setVol(this.value)" style="width:100px;">' +
                '</div>' +
                '<div id="audioStatus" style="margin-top:10px;font-size:12px;color:#aaa;">Not connected</div>' +
                '</div>';
            return true;
        }

        // Try immediately; if p19 not ready yet, poll for it
        if (!registerAudioTab()) {
            var tries = 0;
            var poll = setInterval(function () {
                if (registerAudioTab() || ++tries > 40) clearInterval(poll);
            }, 500);
        }

        // ── Audio plugin globals ───────────────────────────────────────────────
        window.audioPlugin_ws  = null;
        window.audioPlugin_ctx = null;
        window.audioPlugin_gain = null;
        window.audioPlugin_nextTime = 0;
        window.audioPlugin_sr = 44100;
        window.audioPlugin_ch = 2;
        window.audioPlugin_headerParsed = false;

        window.audioPlugin_setStatus = function (msg) {
            var el = document.getElementById('audioStatus');
            if (el) el.textContent = msg;
        };

        window.audioPlugin_setVol = function (v) {
            if (window.audioPlugin_gain) window.audioPlugin_gain.gain.value = parseFloat(v);
        };

        window.audioPlugin_start = function () {
            if (!currentNode) { alert('No device selected'); return; }
            window.audioPlugin_stop();

            var nodeid    = currentNode._id;
            var tunnelId  = 'aud' + Math.random().toString(36).substr(2, 9);
            var relayPath = '/meshrelay.ashx?p=201&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            var proto     = (location.protocol === 'https:') ? 'wss:' : 'ws:';

            // Tell server to push tunnel URL to agent
            meshserver.send(JSON.stringify({
                action: 'msg',
                nodeid: nodeid,
                type: 'tunnel',
                value: relayPath
            }));

            // Open browser half of relay
            var ws = new WebSocket(proto + '//' + location.host + relayPath + '&browser=1');
            ws.binaryType = 'arraybuffer';
            window.audioPlugin_ws = ws;
            window.audioPlugin_headerParsed = false;
            window.audioPlugin_setStatus('Connecting...');

            var startBtn = document.getElementById('audioStartBtn');
            var stopBtn  = document.getElementById('audioStopBtn');
            if (startBtn) startBtn.disabled = true;
            if (stopBtn)  stopBtn.disabled  = false;

            ws.onmessage = function (e) {
                if (typeof e.data === 'string') {
                    // 'c' or 'cr' = relay paired, send protocol number then start command
                    if (e.data === 'c' || e.data === 'cr') {
                        ws.send('201');
                        setTimeout(function () {
                            if (ws.readyState === WebSocket.OPEN) ws.send('start');
                        }, 80);
                        window.audioPlugin_setStatus('Waiting for audio...');
                    } else if (e.data.indexOf('AUDIO:') === 0) {
                        // Header line: AUDIO:sampleRate:channels:16
                        var parts = e.data.split(':');
                        window.audioPlugin_sr = parseInt(parts[1]) || 44100;
                        window.audioPlugin_ch = parseInt(parts[2]) || 2;
                        window.audioPlugin_headerParsed = true;
                        window.audioPlugin_setStatus('Streaming (' + window.audioPlugin_sr + ' Hz, ' + window.audioPlugin_ch + 'ch)');
                    }
                } else if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
                    audioPlugin_playPCM(e.data);
                }
            };

            ws.onclose = function () {
                window.audioPlugin_ws = null;
                var sb = document.getElementById('audioStartBtn');
                var eb = document.getElementById('audioStopBtn');
                if (sb) sb.disabled = false;
                if (eb) eb.disabled = true;
                if (window.audioPlugin_ctx) {
                    try { window.audioPlugin_ctx.close(); } catch (x) {}
                    window.audioPlugin_ctx = null;
                    window.audioPlugin_gain = null;
                }
                window.audioPlugin_setStatus('Disconnected');
            };

            ws.onerror = function () {
                window.audioPlugin_setStatus('Connection error — check agent is online');
            };
        };

        window.audioPlugin_stop = function () {
            if (window.audioPlugin_ws) {
                try { window.audioPlugin_ws.send('stop'); } catch (x) {}
                try { window.audioPlugin_ws.close(); } catch (x) {}
                window.audioPlugin_ws = null;
            }
            if (window.audioPlugin_ctx) {
                try { window.audioPlugin_ctx.close(); } catch (x) {}
                window.audioPlugin_ctx = null;
                window.audioPlugin_gain = null;
            }
            window.audioPlugin_setStatus('Stopped');
            var sb = document.getElementById('audioStartBtn');
            var eb = document.getElementById('audioStopBtn');
            if (sb) sb.disabled = false;
            if (eb) eb.disabled = true;
        };

        window.audioPlugin_playPCM = function (buffer) {
            // Lazy-init AudioContext
            if (!window.audioPlugin_ctx) {
                window.audioPlugin_ctx = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: window.audioPlugin_sr || 44100
                });
                window.audioPlugin_gain = window.audioPlugin_ctx.createGain();
                var vol = document.getElementById('audioVolumeSlider');
                window.audioPlugin_gain.gain.value = vol ? parseFloat(vol.value) : 0.8;
                window.audioPlugin_gain.connect(window.audioPlugin_ctx.destination);
                window.audioPlugin_nextTime = window.audioPlugin_ctx.currentTime + 0.1;
            }

            var sr = window.audioPlugin_sr || 44100;
            var ch = window.audioPlugin_ch || 2;
            var int16  = new Int16Array(buffer);
            var frames = Math.floor(int16.length / ch);
            if (frames === 0) return;

            var audioBuffer = window.audioPlugin_ctx.createBuffer(ch, frames, sr);
            for (var c = 0; c < ch; c++) {
                var channelData = audioBuffer.getChannelData(c);
                for (var i = 0; i < frames; i++) {
                    channelData[i] = int16[i * ch + c] / 32768.0;
                }
            }

            var source = window.audioPlugin_ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(window.audioPlugin_gain);

            var now = window.audioPlugin_ctx.currentTime;
            if (window.audioPlugin_nextTime < now + 0.05) {
                window.audioPlugin_nextTime = now + 0.05;
            }
            source.start(window.audioPlugin_nextTime);
            window.audioPlugin_nextTime += audioBuffer.duration;
        };

    }; // end onWebUIStartupEnd

    return obj;
};
