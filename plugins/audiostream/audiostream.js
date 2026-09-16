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
        window.audioPlugin_sr           = 48000;
        window.audioPlugin_ch           = 1;
        window.audioPlugin_headerParsed = false;
        window.audioPlugin_pcmLeftover  = null;

        // ── Device selection state ─────────────────────────────────────────────
        // -1 = system default endpoint; >=0 = IMMDeviceCollection index on the agent.
        // Populated via DEVICES: message sent by win-audio-capture.js on connect.
        var _selectedDevIdx = -1;

        // ── Volume / mute state (persists across reconnects) ────────────────────
        var _volume = 0.85;
        var _muted  = false;
        function _applyGain() {
            if (window.audioPlugin_gain) window.audioPlugin_gain.gain.value = _muted ? 0 : _volume;
        }

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

        // ── Subtitle-style caption bar (pinned bottom, last 2 lines) ─────────────
        var _captionLines = [];

        function buildCaptionBox() {
            if (document.getElementById('mc-caption-popup')) return;

            // Subtitle bar — dark translucent strip at bottom of screen
            var popup = document.createElement('div');
            popup.id = 'mc-caption-popup';
            popup.style.cssText =
                'position:fixed;bottom:0;left:0;right:0;' +
                'background:rgba(0,0,0,0.78);' +
                'padding:10px 20px 14px;' +
                'font-family:Arial,sans-serif;font-size:22px;font-weight:bold;' +
                'color:#fff;text-align:center;line-height:1.35;' +
                'z-index:99999;display:none;' +
                'text-shadow:1px 1px 3px #000,0 0 6px #000;' +
                'pointer-events:none;';

            var content = document.createElement('div');
            content.id = 'mc-caption-box';
            popup.appendChild(content);

            // Close button (small, top-right, pointer-events restored)
            var closeBtn = document.createElement('button');
            closeBtn.textContent = '×';
            closeBtn.title = 'Hide captions';
            closeBtn.style.cssText =
                'position:absolute;top:4px;right:8px;' +
                'background:transparent;border:none;color:#aaa;' +
                'font-size:18px;cursor:pointer;pointer-events:auto;line-height:1;';
            closeBtn.onclick = function () { setCaptionVisible(false); };
            popup.appendChild(closeBtn);

            document.body.appendChild(popup);
        }

        function appendCaption(text, isHistory) {
            if (isHistory) return; // subtitle bar shows only live speech
            _captionLines.push(text);
            if (_captionLines.length > 2) _captionLines.shift();
            var box = document.getElementById('mc-caption-box');
            if (box) box.textContent = _captionLines.join('\n');
        }

        function clearCaptions() {
            _captionLines = [];
            var box = document.getElementById('mc-caption-box');
            if (box) box.textContent = '';
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

            // Device select — hidden until DEVICES: arrives with >1 endpoints.
            // Lets user pick which audio endpoint to capture (fixes Lockdown Browser
            // audio missing when it routes to a non-default endpoint).
            var sel = document.createElement('select');
            sel.id = 'mc-audio-devsel';
            sel.title = 'Audio capture device';
            sel.style.cssText =
                'display:none;float:left;cursor:pointer;padding:2px 4px;margin:0 2px;border-radius:4px;' +
                'font-size:11px;background:#2a2a2a;color:#ddd;border:1px solid #555;' +
                'max-width:170px;vertical-align:middle;height:22px;';
            sel.innerHTML = '<option value="-1">System default</option>';
            sel.onchange = function () {
                _selectedDevIdx = parseInt(sel.value);
                // If already streaming, restart on the newly selected device.
                if (window.audioPlugin_ws) {
                    audioPlugin_stop();
                    setTimeout(function () { audioPlugin_start(); }, 250);
                }
            };
            slot.appendChild(sel);

            // Audio button
            var btn = document.createElement('div');
            btn.id        = 'mc-audio-btn';
            btn.className = 'deskareaicon';
            btn.title     = 'Audio Monitor';
            btn.style.cssText =
                'float:left;cursor:pointer;padding:2px 8px;margin:0 2px;border-radius:4px;' +
                'font-size:13px;user-select:none;transition:background 0.25s,color 0.25s;' +
                'background:#3a3a3a;color:#ddd;border:1px solid #555;';
            btn.innerHTML = '&#127908;&nbsp;Audio';
            btn.onclick = function () {
                if (window.audioPlugin_ws) { audioPlugin_stop(); }
                else                       { audioPlugin_start(); }
            };
            slot.appendChild(btn);

            // Mute toggle
            var muteBtn = document.createElement('div');
            muteBtn.id        = 'mc-audio-mute';
            muteBtn.className = 'deskareaicon';
            muteBtn.title     = 'Mute';
            muteBtn.style.cssText =
                'float:left;cursor:pointer;padding:2px 6px;margin:0 2px;border-radius:4px;' +
                'font-size:13px;user-select:none;' +
                'background:#3a3a3a;color:#ddd;border:1px solid #555;';
            muteBtn.innerHTML = '&#128266;';
            muteBtn.onclick = function () {
                _muted = !_muted;
                muteBtn.innerHTML = _muted ? '&#128263;' : '&#128266;';
                muteBtn.title     = _muted ? 'Unmute' : 'Mute';
                muteBtn.style.background = _muted ? '#7a0000' : '#3a3a3a';
                _applyGain();
            };

            // Volume slider
            var vol = document.createElement('input');
            vol.type  = 'range';
            vol.id    = 'mc-audio-vol';
            vol.min   = '0';
            vol.max   = '150';
            vol.value = String(Math.round(_volume * 100));
            vol.title = 'Volume';
            vol.style.cssText = 'float:left;vertical-align:middle;width:70px;margin:2px 4px;cursor:pointer;';
            vol.oninput = function () {
                _volume = parseInt(vol.value, 10) / 100;
                if (_muted) { _muted = false; muteBtn.innerHTML = '&#128266;'; muteBtn.title = 'Mute'; muteBtn.style.background = '#3a3a3a'; }
                _applyGain();
            };
            slot.appendChild(vol);
            slot.appendChild(muteBtn);

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
                    window.audioPlugin_gain.gain.value = _muted ? 0 : _volume;
                    window.audioPlugin_gain.connect(window.audioPlugin_ctx.destination);
                    window.audioPlugin_nextTime = 0;
                    window.audioPlugin_pcmLeftover = null;
                    window.audioPlugin_fmtLogged = false;

                    // ---- Continuous ring-buffer playback ---------------------
                    // Rather than scheduling one AudioBuffer per tunnel chunk (a
                    // discontinuity at every chunk boundary, and a forced silent
                    // patch whenever the schedule slips), feed all incoming PCM into
                    // one ring buffer drained by a SINGLE continuously-running node
                    // at the context sample rate. Underruns emit brief silence and
                    // auto re-prime -- no clicks, no per-chunk artifacts, and bursty
                    // tunnel delivery is absorbed by the buffer fill level.
                    var _ctxRate = window.audioPlugin_ctx.sampleRate;
                    var _rbFrames = Math.round(_ctxRate * 6);   // 6s capacity (headroom above 2.5s prime)
                    window.audioPlugin_rb = {
                        frames: _rbFrames, ch: 2,
                        buf: new Float32Array(_rbFrames * 2),
                        read: 0, write: 0, count: 0, frac: 0,
                        baseStep: 1.0, adapt: 1.0,               // rate ratio * adaptive slowdown
                        primed: false,
                        env: 0, envStep: 1 / (_ctxRate * 0.005),   // ~5ms fade to hide gap edges
                        prime: Math.round(_ctxRate * 1.00),      // 1s cushion (clean, glitch-free)
                        fillEma: Math.round(_ctxRate * 0.60),    // smoothed fill for rate control
                        framesIn: 0, framesInPrev: 0, arrRatio: 1.0  // arrival-rate feed-forward
                    };
                    var _sp = window.audioPlugin_ctx.createScriptProcessor(16384, 0, 2); // large block: tolerate KVM main-thread stalls
                    _sp.onaudioprocess = function (ev) {
                        var rb = window.audioPlugin_rb, ob = ev.outputBuffer;
                        var Lc = ob.getChannelData(0);
                        var Rc = ob.numberOfChannels > 1 ? ob.getChannelData(1) : null;
                        var n = ob.length, i;
                        if (!rb) { for (i=0;i<n;i++){ Lc[i]=0; if(Rc)Rc[i]=0; } return; }
                        if (!rb.primed && rb.count >= rb.prime) rb.primed = true;
                        // BIT-EXACT playback: rate locked to 1.0 -- no resampling, so the
                        // audio is EXACTLY what the machine plays (correct pitch, clean).
                        // We do NOT slow playback to hide the bandwidth deficit: that warps
                        // music (wrong key + warble). A genuine shortfall instead shows as
                        // an occasional brief silence, which is far less objectionable than
                        // distortion. The real cure is removing the deficit (mono on agent
                        // or lower KVM quality), not resampling.
                        rb.adapt = 1.0;
                        for (i = 0; i < n; i++) {
                            var sL = 0, sR = 0, have = (rb.primed && rb.count >= 3);
                            if (have) {
                                // Cubic Catmull-Rom interpolation over a 4-sample window.
                                var f = rb.frac, ff = f * f, fff = ff * f;
                                var im1 = ((rb.read + rb.frames - 1) % rb.frames) * rb.ch;
                                var i0  = rb.read * rb.ch;
                                var i1  = ((rb.read + 1) % rb.frames) * rb.ch;
                                var i2  = ((rb.read + 2) % rb.frames) * rb.ch;
                                var p0 = rb.buf[im1], p1 = rb.buf[i0], p2 = rb.buf[i1], p3 = rb.buf[i2];
                                sL = 0.5 * ((2*p1) + (-p0+p2)*f + (2*p0-5*p1+4*p2-p3)*ff + (-p0+3*p1-3*p2+p3)*fff);
                                if (rb.ch > 1) {
                                    var q0 = rb.buf[im1+1], q1 = rb.buf[i0+1], q2 = rb.buf[i1+1], q3 = rb.buf[i2+1];
                                    sR = 0.5 * ((2*q1) + (-q0+q2)*f + (2*q0-5*q1+4*q2-q3)*ff + (-q0+3*q1-3*q2+q3)*fff);
                                } else sR = sL;
                                rb.frac += rb.baseStep * rb.adapt;
                                while (rb.frac >= 1) { rb.frac -= 1; rb.read = (rb.read + 1) % rb.frames; rb.count--; }
                            } else if (rb.primed && rb.count < 3) {
                                rb.primed = false; if (window.audioPlugin_stats) window.audioPlugin_stats.underruns++; // underrun -> re-prime
                            }
                            // Short fade envelope so the edges of a gap ramp in/out
                            // instead of clicking (the click was the "disturbed noise").
                            var _tgt = have ? 1 : 0;
                            if (rb.env < _tgt) { rb.env += rb.envStep; if (rb.env > 1) rb.env = 1; }
                            else if (rb.env > _tgt) { rb.env -= rb.envStep; if (rb.env < 0) rb.env = 0; }
                            Lc[i] = sL * rb.env;
                            if (Rc) Rc[i] = sR * rb.env;
                        }
                    };
                    _sp.connect(window.audioPlugin_gain);
                    window.audioPlugin_sp = _sp;
                    // (debug HUD removed)

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
                            if (ws.readyState !== WebSocket.OPEN) return;
                            // Request device list so the dropdown gets populated.
                            // The DEVICES: response is handled below and shows the select
                            // only when the agent exposes more than one render endpoint.
                            ws.send('listDevices');
                            // Start on whichever device the user has selected.
                            var startCmd = _selectedDevIdx >= 0
                                ? 'start:' + _selectedDevIdx
                                : 'start';
                            ws.send(startCmd);
                            agentModuleTimeout = setTimeout(showAgentSilentError, 45000);
                            // Ask agent for saved transcript from previous sessions
                            setTimeout(function () {
                                if (ws.readyState === WebSocket.OPEN) ws.send('getTranscript');
                            }, 300);
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
                        window.audioPlugin_bps = parseInt(parts[3]) || 16;
                        window.audioPlugin_headerParsed = true;
                        setBtn('live', 'Streaming — ' + window.audioPlugin_sr + ' Hz / ' + window.audioPlugin_ch + 'ch\n(click to stop)');

                    } else if (e.data.indexOf('TEXT:') === 0) {
                        var txt = e.data.substring(5).trim();
                        if (txt && txt.indexOf('EMPTY') !== 0) {
                            appendCaption(txt, false);
                        }

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

                    } else if (e.data.indexOf('DEVICES:') === 0) {
                        // Device list from win-audio-capture.js v4.
                        // Show the dropdown only if there are multiple render endpoints —
                        // single-device machines don't need it.
                        try {
                            var devList = JSON.parse(e.data.substring(8));
                            var sel = document.getElementById('mc-audio-devsel');
                            if (sel && devList.length > 1) {
                                // Rebuild options list.
                                sel.innerHTML = '<option value="-1">System default</option>';
                                for (var _di = 0; _di < devList.length; _di++) {
                                    var _opt = document.createElement('option');
                                    _opt.value       = devList[_di].idx;
                                    _opt.textContent = devList[_di].name;
                                    if (devList[_di].idx === _selectedDevIdx) _opt.selected = true;
                                    sel.appendChild(_opt);
                                }
                                sel.style.display = '';
                            }
                        } catch (_de) {}

                    } else if (e.data === 'EXCLUSIVE') {
                        // Device is in exclusive mode — LDB beat the pre-blocker to it.
                        clearTimeout(agentModuleTimeout);
                        try { ws.close(); } catch (_x) {}
                        window.audioPlugin_ws = null;
                        _btnInError = true;
                        var _exBtn = document.getElementById('mc-audio-btn');
                        if (_exBtn) {
                            _exBtn.style.background  = BTN_STYLES.error.bg;
                            _exBtn.style.color       = BTN_STYLES.error.color;
                            _exBtn.style.borderColor = BTN_STYLES.error.border;
                            _exBtn.innerHTML = '&#127908; Exclusive mode — restart LDB';
                            _exBtn.title =
                                'LockDown Browser has the audio device in exclusive mode.\n' +
                                'Fix: on the remote machine open Sound Settings → playback device\n' +
                                '→ Properties → Advanced → uncheck\n' +
                                '"Allow applications to take exclusive control of this device"\n' +
                                'then restart LockDown Browser.';
                        }
                        setTimeout(function () { setBtn('idle'); }, 30000);

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
                    // Some MeshCentral relay/tunnel paths deliver agent-originated
                    // control strings (AUDIO:, TEXT:, ...) as BINARY frames rather than
                    // text. When that happens the format header is never parsed, so
                    // audioPlugin_bps stays at its default and 16-bit PCM gets decoded
                    // as 32-bit float -- completely unintelligible audio. Detect a
                    // control message hiding inside a binary frame and re-dispatch it
                    // as a string. Real PCM contains non-printable bytes in its first
                    // few samples, so it never matches these ASCII prefixes.
                    var _hn = Math.min(20, e.data.byteLength);
                    var _hb = new Uint8Array(e.data, 0, _hn);
                    var _ascii = '';
                    for (var _hi = 0; _hi < _hn; _hi++) {
                        var _cc = _hb[_hi];
                        if (_cc < 32 || _cc > 126) { _ascii = ''; break; }
                        _ascii += String.fromCharCode(_cc);
                    }
                    if (_ascii && /^(AUDIO:|TEXT:|TRANSCRIPT:|DEVICES:|ERROR:|EXCLUSIVE|WAIT)/.test(_ascii)) {
                        if (window.audioPlugin_diag) { try { console.log('[audiostream] control arrived as BINARY frame:', _ascii); } catch (_l) {} }
                        var _all = new Uint8Array(e.data), _full = '';
                        for (var _fi = 0; _fi < _all.length; _fi++) _full += String.fromCharCode(_all[_fi]);
                        ws.onmessage({ data: _full });
                        return;
                    }
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
            var bps = window.audioPlugin_bps || 16;
            var bytesPerSample = (bps === 32) ? 4 : 2;
            var frameBytes = ch * bytesPerSample;

            // The PCM arrives as a raw byte stream over the MeshCentral tunnel, which
            // re-chunks it at ARBITRARY boundaries — an incoming ArrayBuffer is not
            // guaranteed to end on a sample/frame boundary. Decoding each chunk in
            // isolation (a) throws RangeError on odd byte lengths (Int16Array needs an
            // even length) and (b) silently discards the trailing partial frame, which
            // permanently shifts L/R channel alignment for every following sample —
            // heard as continuous distortion/breakup, not a clean signal. Fix: stitch
            // the previous call's leftover bytes onto this chunk and consume only whole
            // frames, carrying the remainder forward to the next call.
            var incoming = new Uint8Array(buffer);
            var leftover = window.audioPlugin_pcmLeftover;
            var bytes;
            if (leftover && leftover.length) {
                bytes = new Uint8Array(leftover.length + incoming.length);
                bytes.set(leftover, 0);
                bytes.set(incoming, leftover.length);
            } else {
                bytes = incoming;
            }
            var usable = bytes.length - (bytes.length % frameBytes);
            window.audioPlugin_pcmLeftover = (usable < bytes.length) ? bytes.slice(usable) : null;
            if (usable === 0) return;

            // slice() into a fresh 0-offset ArrayBuffer so the typed-array views below
            // are guaranteed alignment-safe regardless of the source byteOffset.
            var aligned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable);
            var f32;
            if (bps === 32) {
                f32 = new Float32Array(aligned);
            } else {
                var i16 = new Int16Array(aligned);
                f32 = new Float32Array(i16.length);
                for (var j = 0; j < i16.length; j++) f32[j] = i16[j] / 32768.0;
            }
            var frames = Math.floor(f32.length / ch);
            if (frames === 0) return;

            var rb = window.audioPlugin_rb;
            if (!rb) return;
            var ctxRate = window.audioPlugin_ctx.sampleRate;
            rb.ch = ch;
            rb.baseStep = sr / ctxRate;   // 1.0 when source (48000) matches the context rate
            if (!window.audioPlugin_fmtLogged) { window.audioPlugin_fmtLogged = true; try { console.log("[audiostream] decoding sr=" + sr + " ch=" + ch + " bps=" + bps + " ctxRate=" + ctxRate + " baseStep=" + rb.baseStep.toFixed(4) + " headerParsed=" + !!window.audioPlugin_headerParsed); } catch (_l) {} }

            // Push decoded interleaved frames into the ring. On overflow (tab
            // backgrounded, or latency crept up) drop the oldest frames so latency
            // stays bounded instead of the buffer wrapping over unread data.
            for (var fi = 0; fi < frames; fi++) {
                if (rb.count >= rb.frames) { rb.read = (rb.read + 1) % rb.frames; rb.count--; }
                var wb = rb.write * rb.ch;
                for (var wc = 0; wc < ch; wc++) rb.buf[wb + wc] = f32[fi * ch + wc];
                rb.write = (rb.write + 1) % rb.frames;
                rb.count++;
            }
            rb.framesIn += frames;
        };

    }; // end onWebUIStartupEnd

    return obj;
};
