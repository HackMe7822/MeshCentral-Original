'use strict';

/*
 * audiostream.js -- Creations IT Audio Monitor plugin (server-side / browser-injected)
 *
 * Single toolbar button in the KVM desktop bar:
 *   click → connects + turns green
 *   click again → disconnects + back to gray
 *   CC button → toggle live caption box (SAPI transcription from agent)
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

        var _btnInError = false;
        var _ccVisible  = false;

        // ── Caption popup (draggable floating window) ──────────────────────────
        function buildCaptionBox() {
            if (document.getElementById('mc-caption-popup')) return;

            var popup = document.createElement('div');
            popup.id = 'mc-caption-popup';
            popup.style.cssText =
                'display:none;position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
                'width:600px;max-width:94vw;' +
                'background:#fff;color:#111;' +
                'border:1px solid #bbb;border-radius:6px;' +
                'font-family:sans-serif;z-index:99999;' +
                'box-shadow:0 4px 18px rgba(0,0,0,0.25);';

            // Title bar / drag handle
            var titleBar = document.createElement('div');
            titleBar.style.cssText =
                'display:flex;align-items:center;padding:5px 8px;' +
                'background:#f0f0f0;border-radius:6px 6px 0 0;' +
                'cursor:move;user-select:none;border-bottom:1px solid #ccc;';

            var titleText = document.createElement('span');
            titleText.style.cssText = 'flex:1;font-size:12px;font-weight:bold;color:#444;letter-spacing:.5px;';
            titleText.textContent = 'Live Captions';

            function _mkBtn(label, tip, col) {
                var b = document.createElement('button');
                b.textContent = label; b.title = tip;
                b.style.cssText =
                    'background:#fff;border:1px solid #bbb;border-radius:3px;' +
                    'cursor:pointer;font-size:13px;padding:1px 6px;margin:0 2px;' +
                    'color:' + (col || '#333') + ';line-height:1.3;';
                return b;
            }

            var refreshBtn = _mkBtn('↺', 'Fetch saved transcript from machine');
            refreshBtn.onclick = function () {
                if (window.audioPlugin_ws && window.audioPlugin_ws.readyState === WebSocket.OPEN) {
                    window.audioPlugin_ws.send('getTranscript');
                }
            };

            var _minimized = false;
            var minBtn = _mkBtn('−', 'Minimize');
            var closeBtn = _mkBtn('×', 'Close captions', '#f88');
            closeBtn.onclick = function () { setCaptionVisible(false); };

            // Content area (scrollable transcript)
            var content = document.createElement('div');
            content.id = 'mc-caption-box';
            content.style.cssText =
                'max-height:180px;overflow-y:auto;background:#fff;' +
                'padding:10px 14px;font-size:13px;line-height:1.6;word-wrap:break-word;' +
                'border-radius:0 0 6px 6px;';

            minBtn.onclick = function () {
                _minimized = !_minimized;
                content.style.display = _minimized ? 'none' : '';
                minBtn.textContent = _minimized ? '+' : '−';
                minBtn.title       = _minimized ? 'Expand' : 'Minimize';
            };

            titleBar.appendChild(titleText);
            titleBar.appendChild(refreshBtn);
            titleBar.appendChild(minBtn);
            titleBar.appendChild(closeBtn);
            popup.appendChild(titleBar);
            popup.appendChild(content);
            document.body.appendChild(popup);

            // Drag logic
            var _drag = false, _sx, _sy, _sl, _st;
            titleBar.addEventListener('mousedown', function (ev) {
                var r = popup.getBoundingClientRect();
                popup.style.transform = '';
                popup.style.bottom    = '';
                popup.style.left      = r.left + 'px';
                popup.style.top       = r.top  + 'px';
                _drag = true; _sx = ev.clientX; _sy = ev.clientY; _sl = r.left; _st = r.top;
                ev.preventDefault();
            });
            document.addEventListener('mousemove', function (ev) {
                if (!_drag) return;
                var nx = Math.max(0, Math.min(window.innerWidth  - 80, _sl + ev.clientX - _sx));
                var ny = Math.max(0, Math.min(window.innerHeight - 30, _st + ev.clientY - _sy));
                popup.style.left = nx + 'px';
                popup.style.top  = ny + 'px';
            });
            document.addEventListener('mouseup', function () { _drag = false; });
        }

        function appendCaption(text, isHistory) {
            var box = document.getElementById('mc-caption-box');
            if (!box) return;
            var line = document.createElement('div');
            line.style.cssText = isHistory
                ? 'color:#888;font-size:12px;border-bottom:1px solid #eee;padding-bottom:3px;margin-bottom:3px;'
                : 'color:#111;';
            line.textContent = text;
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
            while (box.children.length > 80) box.removeChild(box.firstChild);
        }

        function clearCaptions() {
            var box = document.getElementById('mc-caption-box');
            if (box) box.innerHTML = '';
        }

        function setCaptionVisible(v) {
            _ccVisible = v;
            var popup = document.getElementById('mc-caption-popup');
            var ccBtn = document.getElementById('mc-cc-btn');
            if (popup) popup.style.display = v ? 'block' : 'none';
            if (ccBtn) {
                ccBtn.style.background  = v ? '#1a4a7f' : '#3a3a3a';
                ccBtn.style.borderColor = v ? '#3399ff' : '#555';
                ccBtn.title = v ? 'Hide captions' : 'Show live captions';
            }
        }

        // ── Build toolbar buttons ──────────────────────────────────────────────
        function buildAudioUI() {
            if (document.getElementById('mc-audio-btn')) return true;
            var slot = document.getElementById('desktopCustomUiButtons');
            if (!slot) return false;

            // Audio button
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

            // CC (caption) button
            var ccBtn = document.createElement('div');
            ccBtn.id        = 'mc-cc-btn';
            ccBtn.className = 'deskareaicon';
            ccBtn.title     = 'Show live captions';
            ccBtn.style.cssText =
                'cursor:pointer;padding:2px 7px;margin:0 2px;border-radius:4px;' +
                'font-size:12px;font-weight:bold;user-select:none;' +
                'background:#3a3a3a;color:#ddd;border:1px solid #555;';
            ccBtn.textContent = 'CC';
            ccBtn.onclick = function () { setCaptionVisible(!_ccVisible); };
            slot.appendChild(ccBtn);

            buildCaptionBox();
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

            audioPlugin_stop();

            var nodeid   = currentNode._id;
            var tunnelId = 'aud' + Math.random().toString(36).substr(2, 9);
            var durl     = (typeof domainUrl !== 'undefined' && domainUrl) ? domainUrl : '/';
            var proto    = (location.protocol === 'https:') ? 'wss:' : 'ws:';

            var agentUrl = '*' + durl + 'meshrelay.ashx?p=2&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            if (typeof authRelayCookie !== 'undefined' && authRelayCookie) {
                agentUrl += '&rauth=' + authRelayCookie;
            }

            var browserUrl = proto + '//' + location.host + durl +
                'meshrelay.ashx?browser=1&p=2&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelId;
            if (typeof authCookie !== 'undefined' && authCookie) {
                browserUrl += '&auth=' + authCookie;
            }

            setBtn('connecting', 'Connecting…');

            if (!window.audioPlugin_ctx) {
                try {
                    window.audioPlugin_ctx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
                    window.audioPlugin_gain = window.audioPlugin_ctx.createGain();
                    window.audioPlugin_gain.gain.value = 0.85;
                    window.audioPlugin_gain.connect(window.audioPlugin_ctx.destination);
                    window.audioPlugin_nextTime = 0;
                } catch (ex) { window.audioPlugin_ctx = null; }
            }

            meshserver.send({ action: 'msg', type: 'tunnel', nodeid: nodeid, value: agentUrl, usage: 2 });

            var ws = new WebSocket(browserUrl);
            ws.binaryType = 'arraybuffer';
            window.audioPlugin_ws           = ws;
            window.audioPlugin_headerParsed = false;

            var relayPaired    = false;
            var keepaliveTimer = null;
            var connectTimeout = setTimeout(function () {
                if (!relayPaired) {
                    setBtn('error', 'Agent did not respond — is the device online?');
                    audioPlugin_stop();
                    setTimeout(function () { setBtn('idle'); }, 4000);
                }
            }, 12000);

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
                    errBtn.title = 'The audio module is not running on this device.';
                }
                setTimeout(function () { setBtn('idle'); }, 20000);
            }

            ws.onmessage = function (e) {
                if (typeof e.data === 'string') {

                    if (e.data === 'c' || e.data === 'cr') {
                        relayPaired = true;
                        clearTimeout(connectTimeout);
                        ws.send('201');
                        setTimeout(function () {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send('start');
                                agentModuleTimeout = setTimeout(showAgentSilentError, 45000);
                                // Ask agent for saved transcript from previous sessions
                                setTimeout(function () {
                                    if (ws.readyState === WebSocket.OPEN) ws.send('getTranscript');
                                }, 300);
                            }
                        }, 80);
                        keepaliveTimer = setInterval(function () {
                            if (ws.readyState === WebSocket.OPEN) { try { ws.send('ping'); } catch (_) {} }
                        }, 4000);
                        setBtn('connecting', 'Starting capture… (first run may take ~30s)');

                    } else if (e.data === 'WAIT') {
                        clearTimeout(agentModuleTimeout);
                        agentModuleTimeout = setTimeout(showAgentSilentError, 25000);
                        setBtn('connecting', 'Starting audio service… please wait (~5s)');

                    } else if (e.data.indexOf('AUDIO:') === 0) {
                        clearTimeout(agentModuleTimeout);
                        var parts = e.data.split(':');
                        window.audioPlugin_sr  = parseInt(parts[1]) || 48000;
                        window.audioPlugin_ch  = parseInt(parts[2]) || 2;
                        window.audioPlugin_bps = parseInt(parts[3]) || 32;
                        window.audioPlugin_headerParsed = true;
                        setBtn('live', 'Streaming — ' + window.audioPlugin_sr + ' Hz / ' + window.audioPlugin_ch + 'ch\n(click to stop)');

                    } else if (e.data.indexOf('TEXT:') === 0) {
                        // Live caption from agent SAPI
                        var txt = e.data.substring(5);
                        if (txt) appendCaption(txt, false);

                    } else if (e.data.indexOf('TRANSCRIPT:') === 0) {
                        // Historical transcript lines sent on reconnect (base64-encoded, newline-separated)
                        try {
                            var lines = atob(e.data.substring(11)).split('\n');
                            if (lines.length > 0) {
                                appendCaption('── Previous session ──', true);
                                for (var li = 0; li < lines.length; li++) {
                                    if (lines[li].trim()) appendCaption(lines[li].trim(), true);
                                }
                                appendCaption('── Live ──', true);
                            }
                        } catch (_te) {}

                    } else if (e.data.indexOf('ERROR:') === 0) {
                        clearTimeout(agentModuleTimeout);
                        var fullErr = e.data.substring(6);
                        var shortErr = fullErr.length > 50 ? fullErr.substring(0, 47) + '...' : fullErr;
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
                            errBtn.title = fullErr;
                        }
                        setTimeout(function () { setBtn('idle'); }, 20000);
                    }

                } else if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
                    audioPlugin_playPCM(e.data);
                }
            };

            ws.onclose = function () {
                clearInterval(keepaliveTimer); keepaliveTimer = null;
                clearTimeout(connectTimeout);
                clearTimeout(agentModuleTimeout);
                window.audioPlugin_ws = null;
                if (window.audioPlugin_ctx) {
                    try { window.audioPlugin_ctx.close(); } catch (x) {}
                    window.audioPlugin_ctx  = null;
                    window.audioPlugin_gain = null;
                }
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

            var sr  = window.audioPlugin_sr || 48000;
            var ch  = window.audioPlugin_ch || 2;
            var bps = window.audioPlugin_bps || 32;
            var f32;
            if (bps === 32) {
                f32 = new Float32Array(buffer);
            } else {
                var i16 = new Int16Array(buffer);
                f32 = new Float32Array(i16.length);
                for (var j = 0; j < i16.length; j++) f32[j] = i16[j] / 32768.0;
            }
            var frames = Math.floor(f32.length / ch);
            if (frames === 0) return;

            if (window.audioPlugin_nextTime === 0) {
                window.audioPlugin_nextTime = window.audioPlugin_ctx.currentTime + 0.08;
            }

            var audioBuf = window.audioPlugin_ctx.createBuffer(ch, frames, sr);
            for (var c = 0; c < ch; c++) {
                var chData = audioBuf.getChannelData(c);
                for (var i = 0; i < frames; i++) {
                    chData[i] = f32[i * ch + c];
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
