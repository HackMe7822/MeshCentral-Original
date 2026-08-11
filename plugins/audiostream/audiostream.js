'use strict';

/*
 * audiostream.js -- Creations IT Audio Monitor plugin (server-side / browser-injected)
 *
 * Single toolbar button in the KVM desktop bar:
 *   click → connects + turns green
 *   click again → disconnects + back to gray
 *
 * No panels, no sliders. Status shown via button colour + hover tooltip.
 * Protocol 201 relay tunnel → win-audio-capture.js on the agent.
 */

module.exports.audiostream = function (pluginHandler) {
    var obj = {};
    obj.pluginHandler = pluginHandler;
    obj.server_startup = function () {};
    obj.exports = ['onWebUIStartupEnd'];

    obj.onWebUIStartupEnd = function () {

        // ── Audio state ────────────────────────────────────────────────────────
        window.audioPlugin_ws           = null;
        window.audioPlugin_ctx          = null;
        window.audioPlugin_gain         = null;
        window.audioPlugin_nextTime     = 0;
        window.audioPlugin_sr           = 44100;
        window.audioPlugin_ch           = 2;
        window.audioPlugin_headerParsed = false;

        // ── Button visuals ─────────────────────────────────────────────────────
        var BTN_STYLES = {
            idle:       { bg: '#3a3a3a', color: '#ddd', border: '#555',    html: '&#127908;&nbsp;Audio' },
            connecting: { bg: '#b30000', color: '#fff', border: '#ff2222', html: '&#127908;&nbsp;Connecting&#8230;' },
            live:       { bg: '#1a7f3c', color: '#fff', border: '#28d163', html: '&#127908;&nbsp;Live' },
            error:      { bg: '#7a0000', color: '#fcc', border: '#c00',    html: '&#127908;&nbsp;&#215;&nbsp;Error' }
        };

        function setBtn(state, tip) {
            var btn = document.getElementById('mc-audio-btn');
            if (!btn) return;
            _btnInError = (state === 'error');
            var s = BTN_STYLES[state] || BTN_STYLES.idle;
            btn.style.background  = s.bg;
            btn.style.color       = s.color;
            btn.style.borderColor = s.border;
            btn.innerHTML = s.html;
            btn.title = tip || 'Audio Monitor';
        }

        // Track error state separately — avoid CSS color normalisation mismatch
        // (btn.style.background returns 'rgb(...)' not '#rrggbb' in some browsers)
        var _btnInError = false;

        // ── Build toolbar button ───────────────────────────────────────────────
        function buildAudioUI() {
            if (document.getElementById('mc-audio-btn')) return true;
            var slot = document.getElementById('desktopCustomUiButtons');
            if (!slot) return false;

            var btn = document.createElement('div');
            btn.id        = 'mc-audio-btn';
            btn.className = 'deskareaicon';
            btn.title     = 'Audio Monitor';
            btn.style.cssText =
                'cursor:pointer;padding:2px 8px;margin:0 2px;border-radius:4px;' +
                'font-size:13px;user-select:none;transition:background 0.25s,color 0.25s;' +
                'background:#3a3a3a;color:#ddd;border:1px solid #555;';
            btn.innerHTML = '&#127908;&nbsp;Audio';
            btn.onclick = function () {
                if (window.audioPlugin_ws) { audioPlugin_stop(); }
                else                       { audioPlugin_start(); }
            };
            slot.appendChild(btn);
            return true;
        }

        if (!buildAudioUI()) {
            var _tries = 0;
            var _poll  = setInterval(function () {
                if (buildAudioUI() || ++_tries > 120) clearInterval(_poll);
            }, 500);
        }

        // ── Start stream ───────────────────────────────────────────────────────
        window.audioPlugin_start = function () {
            if (!currentNode) {
                setBtn('error', 'No device selected');
                setTimeout(function () { setBtn('idle'); }, 2500);
                return;
            }

            audioPlugin_stop();   // clean up any previous session

            var nodeid   = currentNode._id;
            var tunnelId = 'aud' + Math.random().toString(36).substr(2, 9);
            var durl     = (typeof domainUrl !== 'undefined' && domainUrl) ? domainUrl : '/';
            var proto    = (location.protocol === 'https:') ? 'wss:' : 'ws:';

            // Agent URL starts with '*' so agent prepends its own server host
            var agentUrl = '*' + durl + 'meshrelay.ashx?p=2&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            if (typeof authRelayCookie !== 'undefined' && authRelayCookie) {
                agentUrl += '&rauth=' + authRelayCookie;
            }

            // Browser relay URL
            var browserUrl = proto + '//' + location.host + durl +
                'meshrelay.ashx?browser=1&p=2&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            if (typeof authCookie !== 'undefined' && authCookie) {
                browserUrl += '&auth=' + authCookie;
            }

            setBtn('connecting', 'Connecting…');

            // AudioContext must be created inside a user-gesture handler (this click)
            // so the browser autoplay policy allows it to play immediately.
            if (!window.audioPlugin_ctx) {
                try {
                    window.audioPlugin_ctx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
                    window.audioPlugin_gain = window.audioPlugin_ctx.createGain();
                    window.audioPlugin_gain.gain.value = 0.85;
                    window.audioPlugin_gain.connect(window.audioPlugin_ctx.destination);
                    window.audioPlugin_nextTime = 0;
                } catch (ex) { window.audioPlugin_ctx = null; }
            }

            // Ask the agent to open a relay tunnel to us (meshserver.send already JSON.stringifies)
            meshserver.send({ action: 'msg', type: 'tunnel', nodeid: nodeid, value: agentUrl, usage: 2 });

            var ws = new WebSocket(browserUrl);
            ws.binaryType = 'arraybuffer';
            window.audioPlugin_ws           = ws;
            window.audioPlugin_headerParsed = false;

            // Abort if agent never joins the relay
            var relayPaired    = false;
            var connectTimeout = setTimeout(function () {
                if (!relayPaired) {
                    setBtn('error', 'Agent did not respond — is the device online?');
                    audioPlugin_stop();
                    setTimeout(function () { setBtn('idle'); }, 4000);
                }
            }, 12000);

            // Fired if agent joins but its audio module never sends anything.
            // win-audio-capture.js sends WAIT immediately on 'start' — if we
            // don't get that within 20s the module is not running on the agent.
            var agentModuleTimeout = null;
            function showAgentSilentError() {
                try { ws.close(); } catch (_x) {}
                window.audioPlugin_ws = null;
                if (window.audioPlugin_ctx) {
                    try { window.audioPlugin_ctx.close(); } catch (_x) {}
                    window.audioPlugin_ctx  = null;
                    window.audioPlugin_gain = null;
                }
                _btnInError = true;
                var errBtn = document.getElementById('mc-audio-btn');
                if (errBtn) {
                    errBtn.style.background  = BTN_STYLES.error.bg;
                    errBtn.style.color       = BTN_STYLES.error.color;
                    errBtn.style.borderColor = BTN_STYLES.error.border;
                    errBtn.innerHTML = '&#127908; Module not on agent';
                    errBtn.title     = 'The audio module (win-audio-capture.js) is not running on this device. The plugin may not be deployed to this agent yet.';
                }
                setTimeout(function () { setBtn('idle'); }, 20000);
            }

            ws.onmessage = function (e) {
                if (typeof e.data === 'string') {

                    if (e.data === 'c' || e.data === 'cr') {
                        // Relay paired -- negotiate protocol then start capture
                        relayPaired = true;
                        clearTimeout(connectTimeout);
                        ws.send('201');
                        setTimeout(function () {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send('start');
                                // 45s: enough for Add-Type compilation even without WAIT pings
                                agentModuleTimeout = setTimeout(showAgentSilentError, 45000);
                            }
                        }, 80);
                        setBtn('connecting', 'Starting capture… (first run compiles driver, may take ~30s)');

                    } else if (e.data === 'WAIT') {
                        // Agent module is alive but still starting up (Add-Type compiling)
                        clearTimeout(agentModuleTimeout);
                        agentModuleTimeout = setTimeout(showAgentSilentError, 25000);
                        setBtn('connecting', 'Compiling audio driver… please wait (~30s first run)');

                    } else if (e.data.indexOf('AUDIO:') === 0) {
                        clearTimeout(agentModuleTimeout);
                        // Header from agent: AUDIO:<sr>:<ch>:16
                        var parts = e.data.split(':');
                        window.audioPlugin_sr = parseInt(parts[1]) || 44100;
                        window.audioPlugin_ch = parseInt(parts[2]) || 2;
                        window.audioPlugin_headerParsed = true;
                        setBtn('live', 'Streaming — ' + window.audioPlugin_sr + ' Hz / ' + window.audioPlugin_ch + 'ch\n(click to stop)');

                    } else if (e.data.indexOf('ERROR:') === 0) {
                        clearTimeout(agentModuleTimeout);
                        // Error from agent -- show the actual text IN the button for 20s
                        var fullErr = e.data.substring(6);
                        var shortErr = fullErr.length > 50 ? fullErr.substring(0, 47) + '...' : fullErr;
                        // Close WS but do NOT call audioPlugin_stop() -- that resets button
                        try { ws.close(); } catch (_x) {}
                        window.audioPlugin_ws = null;
                        if (window.audioPlugin_ctx) {
                            try { window.audioPlugin_ctx.close(); } catch (_x) {}
                            window.audioPlugin_ctx  = null;
                            window.audioPlugin_gain = null;
                        }
                        _btnInError = true;
                        var errBtn = document.getElementById('mc-audio-btn');
                        if (errBtn) {
                            errBtn.style.background  = BTN_STYLES.error.bg;
                            errBtn.style.color       = BTN_STYLES.error.color;
                            errBtn.style.borderColor = BTN_STYLES.error.border;
                            errBtn.innerHTML = '&#127908; ' + shortErr;
                            errBtn.title     = fullErr;
                        }
                        setTimeout(function () { setBtn('idle'); }, 20000);
                    }

                } else if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
                    audioPlugin_playPCM(e.data);
                }
            };

            ws.onclose = function () {
                clearTimeout(connectTimeout);
                clearTimeout(agentModuleTimeout);
                window.audioPlugin_ws = null;
                if (window.audioPlugin_ctx) {
                    try { window.audioPlugin_ctx.close(); } catch (x) {}
                    window.audioPlugin_ctx  = null;
                    window.audioPlugin_gain = null;
                }
                // Use _btnInError flag (not CSS comparison — browsers normalise colours)
                if (!_btnInError) { setBtn('idle'); }
            };

            ws.onerror = function () {
                clearTimeout(connectTimeout);
                setBtn('error', 'WebSocket error');
                setTimeout(function () { setBtn('idle'); }, 3000);
            };
        };

        // ── Stop stream ────────────────────────────────────────────────────────
        window.audioPlugin_stop = function () {
            if (window.audioPlugin_ws) {
                try { window.audioPlugin_ws.send('stop'); } catch (x) {}
                try { window.audioPlugin_ws.close(); }     catch (x) {}
                window.audioPlugin_ws = null;
            }
            if (window.audioPlugin_ctx) {
                try { window.audioPlugin_ctx.close(); } catch (x) {}
                window.audioPlugin_ctx  = null;
                window.audioPlugin_gain = null;
                window.audioPlugin_nextTime = 0;
            }
            setBtn('idle');
        };

        // ── PCM playback via Web Audio API ─────────────────────────────────────
        window.audioPlugin_playPCM = function (buffer) {
            if (!window.audioPlugin_ctx) return;
            if (window.audioPlugin_ctx.state === 'suspended') {
                window.audioPlugin_ctx.resume();
            }

            var sr    = window.audioPlugin_sr || 44100;
            var ch    = window.audioPlugin_ch || 2;
            var int16 = new Int16Array(buffer);
            var frames = Math.floor(int16.length / ch);
            if (frames === 0) return;

            if (window.audioPlugin_nextTime === 0) {
                window.audioPlugin_nextTime = window.audioPlugin_ctx.currentTime + 0.1;
            }

            var audioBuf = window.audioPlugin_ctx.createBuffer(ch, frames, sr);
            for (var c = 0; c < ch; c++) {
                var chData = audioBuf.getChannelData(c);
                for (var i = 0; i < frames; i++) {
                    chData[i] = int16[i * ch + c] / 32768.0;
                }
            }

            var src = window.audioPlugin_ctx.createBufferSource();
            src.buffer = audioBuf;
            src.connect(window.audioPlugin_gain);

            var now = window.audioPlugin_ctx.currentTime;
            if (window.audioPlugin_nextTime < now + 0.05) {
                window.audioPlugin_nextTime = now + 0.05;
            }
            src.start(window.audioPlugin_nextTime);
            window.audioPlugin_nextTime += audioBuf.duration;
        };

    }; // end onWebUIStartupEnd

    return obj;
};
