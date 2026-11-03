// One Euro filter (Casiez et al., CHI 2012): low lag when moving fast,
// strong smoothing when still. Used to stabilise landmark trajectories.

class LowPass {
    constructor() { this.y = null; }
    filter(x, alpha) { this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y; return this.y; }
}

function alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
    constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
        Object.assign(this, { minCutoff, beta, dCutoff });
        this.x = new LowPass(); this.dx = new LowPass(); this.lastT = null; this.lastX = null;
    }
    filter(value, tSeconds) {
        const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, tSeconds - this.lastT);
        const dValue = this.lastX === null ? 0 : (value - this.lastX) / dt;
        const edx = this.dx.filter(dValue, alpha(this.dCutoff, dt));
        const cutoff = this.minCutoff + this.beta * Math.abs(edx);
        const out = this.x.filter(value, alpha(cutoff, dt));
        this.lastT = tSeconds; this.lastX = out;
        return out;
    }
    reset() { this.x = new LowPass(); this.dx = new LowPass(); this.lastT = null; this.lastX = null; }
}

/** Filters an N x D array of points (e.g. 12 joints x 3 coordinates). */
export class SkeletonFilter {
    constructor(numPoints, dims = 3, opts = {}) {
        this.f = Array.from({ length: numPoints }, () => Array.from({ length: dims }, () => new OneEuroFilter(opts)));
    }
    filter(points, tSeconds) {
        return points.map((p, i) => p.map((v, d) => this.f[i][d].filter(v, tSeconds)));
    }
    reset() { this.f.forEach(row => row.forEach(f => f.reset())); }
}
