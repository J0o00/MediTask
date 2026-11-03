// Stub MediaPipe Pose + Camera: emits synthetic squat landmarks (3 s per repetition).
(function () {
    let gen = null;
    import(location.origin + '/tests/helpers/synthetic-pose.mjs').then(m => { gen = m; });
    window.Pose = class {
        setOptions() {} onResults(cb) { this.cb = cb; } close() {}
        async send() {
            if (!gen || !this.cb) return;
            const t = performance.now() / 1000, period = 3.0, x = (t % period) / period;
            const p = x < 0.15 ? 0 : x > 0.85 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * 2 * (x - 0.15) / 0.7);
            this.cb(gen.toResults(gen.setSquat(gen.standingPose(), 175 - 82 * p)));
        }
    };
    window.Camera = class {
        constructor(_v, o) { this.o = o; this.on = false; }
        start() { this.on = true; const loop = async () => { if (!this.on) return; await this.o.onFrame(); setTimeout(loop, 33); }; loop(); }
        stop() { this.on = false; }
    };
})();
