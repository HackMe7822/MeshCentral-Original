'use strict';

/*
 * audiostream.js -- Creations IT MeshCentral Audio Stream Plugin (server-side)
 *
 * Injects an Audio button into the KVM desktop toolbar (desktopCustomUiButtons).
 * Protocol 201 tunnel: browser sends '201' then 'start'/'stop',
 * agent (win-audio-capture.js) streams 16-bit PCM back.
 */

module.exports.audiostream = function (pluginHandler) {
    var obj = {};
    obj.pluginHandler = pluginHandler;

    obj.server_startup = function () {};

    obj.exports = ['onWebUIStartupEnd'];

    obj.onWebUIStartupEnd = function () {

        // -- Audio state --
        window.audioPlugin_ws           = null;
        window.audioPlugin_ctx          = null;
        window.audioPlugin_gain         = null;
        window.audioPlugin_nextTime     = 0;
        window.audioPlugin_sr           = 44100;
        window.audioPlugin_ch           = 2;
        window.audioPlugin_headerParsed = false;

        // -- Build KVM toolbar button + floating panel --
        function buildAudioUI() {
            if (document.getElementById('mc-audio-btn')) return true;
            var btnSlot = document.getElementById('desktopCustomUiButtons');
            if (!btnSlot) return false;

            // Toolbar button
            var btn = document.createElement('div');
            btn.id = 'mc-audio-btn';
            btn.title = 'Audio Monitor';
            btn.className = 'deskareaicon';
            btn.style.cssText = 'cursor:pointer;padding:2px 8px;margin:0 2px;border-radius:4px;' +
                'font-size:13px;user-select:none;background:#3a3a3a;color:#ddd;border:1px solid #555;';
            btn.innerHTML = '&#127908;&nbsp;Audio';
            btn.onclick = function () { mc_audio_togglePanel(); };
            btnSlot.appendChild(btn);

            // Floating panel (hidden by default)
            var panel = document.createElement('div');
            panel.id = 'mc-audio-panel';
            panel.style.cssText = 'display:none;position:fixed;right:16px;top:60px;z-index:9999;' +
                'background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:8px;' +
                'padding:14px 18px;min-width:220px;box-shadow:0 4px 18px rgba(0,0,0,0.7);' +
                'font-family:sans-serif;font-size:13px;';
            panel.innerHTML =
                '<div style="font-weight:600;margin-bottom:10px;font-size:14px;">&#127908; Audio Monitor</div>' +
                '<div style="margin-bottom:10px;color:#aaa;font-size:11px;">Streams system audio from the remote device.</div>' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                '  <button id="mc-audio-listen" onclick="audioPlugin_start()"' +
                '    style="padding:5px 14px;cursor:pointer;background:#1a7f3c;color:#fff;' +
                '    border:none;border-radius:4px;font-size:13px;">&#9654; Listen</button>' +
                '  <button id="mc-audio-stop" onclick="audioPlugin_stop()" disabled' +
                '    style="padding:5px 14px;cursor:pointer;background:#555;color:#ccc;' +
                '    border:none;border-radius:4px;font-size:13px;">&#9646;&#9646; Stop</button>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                '  <span style="font-size:11px;color:#aaa;">Volume</span>' +
                '  <input type="range" id="audioVolumeSlider" min="0" max="1" step="0.05" value="0.8"' +
                '    oninput="audioPlugin_setVol(this.value)" style="flex:1;cursor:pointer;">' +
                '</div>' +
                '<div id="mc-audio-status" style="font-size:11px;color:#888;">Not connected</div>' +
                '<div style="text-align:right;margin-top:10px;">' +
                '  <span onclick="mc_audio_closePanel()" style="cursor:pointer;font-size:11px;color:#777;">Close x</span>' +
                '</div>';
            document.body.appendChild(panel);
            return true;
        }

        // Poll until KVM toolbar appears
        if (!buildAudioUI()) {
            var tries = 0;
            var poll = setInterval(function () {
                if (buildAudioUI() || ++tries > 120) clearInterval(poll);
            }, 500);
        }

        // -- Panel open/close --
        window.mc_audio_togglePanel = function () {
            var p = document.getElementById('mc-audio-panel');
            if (p) p.style.display = (p.style.display === 'none') ? 'block' : 'none';
        };

        window.mc_audio_closePanel = function () {
            audioPlugin_stop();
            var p = document.getElementById('mc-audio-panel');
            if (p) p.style.display = 'none';
        };

        // -- Button / status helpers --
        function setListenActive(active) {
            var btn = document.getElementById('mc-audio-btn');
            if (btn) {
                btn.style.background  = active ? '#8b0000' : '#3a3a3a';
                btn.style.color       = active ? '#fff'    : '#ddd';
                btn.style.borderColor = active ? '#c00'    : '#555';
                btn.innerHTML = active ? '&#127908;&nbsp;Live' : '&#127908;&nbsp;Audio';
            }
        }

        function setButtons(connecting) {
            // connecting=true: Listen disabled, Stop enabled (always when attempting)
            var listenBtn = document.getElementById('mc-audio-listen');
            var stopBtn   = document.getElementById('mc-audio-stop');
            if (listenBtn) listenBtn.disabled = connecting;
            if (stopBtn) {
                stopBtn.disabled = !connecting;
                stopBtn.style.background = connecting ? '#a00' : '#555';
                stopBtn.style.color      = connecting ? '#fff' : '#ccc';
            }
        }

        window.audioPlugin_setStatus = function (msg) {
            var el = document.getElementById('mc-audio-status');
            if (el) el.textContent = msg;
        };

        window.audioPlugin_setVol = function (v) {
            if (window.audioPlugin_gain) window.audioPlugin_gain.gain.value = parseFloat(v);
        };

        // -- Start stream --
        window.audioPlugin_start = function () {
            if (!currentNode) { audioPlugin_setStatus('No device selected'); return; }
            audioPlugin_stop();

            var nodeid    = currentNode._id;
            var tunnelId  = 'aud' + Math.random().toString(36).substr(2, 9);
            var relayPath = '/meshrelay.ashx?p=201&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            var proto     = (location.protocol === 'https:') ? 'wss:' : 'ws:';

            // Enable Stop immediately so user can always cancel
            setButtons(true);
            setListenActive(false);
            audioPlugin_setStatus('Connecting...');

            meshserver.send(JSON.stringify({
                action: 'msg',
                nodeid: nodeid,
                type: 'tunnel',
                value: relayPath
            }));

            var ws = new WebSocket(proto + '//' + location.host + relayPath + '&browser=1');
            ws.binaryType = 'arraybuffer';
            window.audioPlugin_ws = ws;
            window.audioPlugin_headerParsed = false;

            // Auto-cancel if agent never joins within 12 seconds
            var relayPaired = false;
            var connectTimeout = setTimeout(function () {
                if (!relayPaired) {
                    audioPlugin_setStatus('Agent did not respond -- is the device online?');
                    audioPlugin_stop();
                }
            }, 12000);

            ws.onmessage = function (e) {
                if (typeof e.data === 'string') {
                    if (e.data === 'c' || e.data === 'cr') {
                        relayPaired = true;
                        clearTimeout(connectTimeout);
                        ws.send('201');
                        setTimeout(function () {
                            if (ws.readyState === WebSocket.OPEN) ws.send('start');
                        }, 80);
                        setListenActive(true);
                        audioPlugin_setStatus('Waiting for audio...');
                    } else if (e.data.indexOf('AUDIO:') === 0) {
                        var parts = e.data.split(':');
                        window.audioPlugin_sr = parseInt(parts[1]) || 44100;
                        window.audioPlugin_ch = parseInt(parts[2]) || 2;
                        window.audioPlugin_headerParsed = true;
                        audioPlugin_setStatus('Streaming ' + window.audioPlugin_sr + ' Hz');
                    }
                } else if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
                    audioPlugin_playPCM(e.data);
                }
            };

            ws.onclose = function () {
                clearTimeout(connectTimeout);
                window.audioPlugin_ws = null;
                if (window.audioPlugin_ctx) {
                    try { window.audioPlugin_ctx.close(); } catch (x) {}
                    window.audioPlugin_ctx = null;
                    window.audioPlugin_gain = null;
                }
                setListenActive(false);
                setButtons(false);
                audioPlugin_setStatus('Disconnected');
            };

            ws.onerror = function () {
                clearTimeout(connectTimeout);
                setListenActive(false);
                setButtons(false);
                audioPlugin_setStatus('Connection error');
            };
        };

        // -- Stop stream --
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
            setListenActive(false);
            setButtons(false);
            audioPlugin_setStatus('Stopped');
        };

        // -- PCM playback via Web Audio API --
        window.audioPlugin_playPCM = function (buffer) {
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

            var sr    = window.audioPlugin_sr || 44100;
            var ch    = window.audioPlugin_ch || 2;
            var int16 = new Int16Array(buffer);
            var frames = Math.floor(int16.length / ch);
            if (frames === 0) return;

            var audioBuf = window.audioPlugin_ctx.createBuffer(ch, frames, sr);
            for (var c = 0; c < ch; c++) {
                var chData = audioBuf.getChannelData(c);
                for (var i = 0; i < frames; i++) {
                    chData[i] = int16[i * ch + c] / 32768.0;
                }
            }

            var source = window.audioPlugin_ctx.createBufferSource();
            source.buffer = audioBuf;
            source.connect(window.audioPlugin_gain);

            var now = window.audioPlugin_ctx.currentTime;
            if (window.audioPlugin_nextTime < now + 0.05) window.audioPlugin_nextTime = now + 0.05;
            source.start(window.audioPlugin_nextTime);
            window.audioPlugin_nextTime += audioBuf.duration;
        };

    }; // end onWebUIStartupEnd

    return obj;
};
