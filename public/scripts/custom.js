// Float32 fix for audioPlugin_playPCM (WASAPI loopback sends Float32, old plugin reads Int16)
// Uses Object.defineProperty so any assignment from the plugin is intercepted and replaced.
(function () {
    var _fix = function (buf) {
        var ctx = window.audioPlugin_ctx;
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        var sr = window.audioPlugin_sr || 48000;
        var ch = window.audioPlugin_ch || 2;
        var bps = window.audioPlugin_bps || 32;
        var f32;
        if (bps === 32) {
            f32 = new Float32Array(buf);
        } else {
            var i16 = new Int16Array(buf);
            f32 = new Float32Array(i16.length);
            for (var j = 0; j < i16.length; j++) f32[j] = i16[j] / 32768;
        }
        var frames = Math.floor(f32.length / ch);
        if (!frames) return;
        if (!window.audioPlugin_nextTime) {
            window.audioPlugin_nextTime = ctx.currentTime + 0.08;
        }
        var ab = ctx.createBuffer(ch, frames, sr);
        for (var c = 0; c < ch; c++) {
            var cd = ab.getChannelData(c);
            for (var i = 0; i < frames; i++) cd[i] = f32[i * ch + c];
        }
        var src = ctx.createBufferSource();
        src.buffer = ab;
        src.connect(window.audioPlugin_gain || ctx.destination);
        var now = ctx.currentTime;
        if (window.audioPlugin_nextTime < now + 0.05) window.audioPlugin_nextTime = now + 0.05;
        src.start(window.audioPlugin_nextTime);
        window.audioPlugin_nextTime += ab.duration;
    };
    Object.defineProperty(window, 'audioPlugin_playPCM', {
        configurable: true, enumerable: true,
        get: function () { return _fix; },
        set: function () {}
    });
})();
