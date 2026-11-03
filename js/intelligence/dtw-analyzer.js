// Dynamic Time Warping: compares the temporal shape of a patient's
// repetition with a reference (therapist-recorded or personal-best template),
// tolerant to differences in speed. Mirrored in ml/meditask_ml/dtw.py.
import { progressOf } from '../rehabilitation/exercise-configs.js';

/**
 * DTW distance between two sequences of equal-dimension vectors (or numbers),
 * with an optional Sakoe-Chiba band (fraction of the longer length).
 * Returned distance is normalised by the warping-path length.
 */
export function dtwDistance(a, b, band = 0.25) {
    const n = a.length, m = b.length;
    if (!n || !m) return Infinity;
    const vec = Array.isArray(a[0]);
    const dist = (x, y) => {
        if (!vec) return Math.abs(x - y);
        let s = 0; for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; s += d * d; } return Math.sqrt(s);
    };
    const w = Math.max(Math.ceil(band * Math.max(n, m)), Math.abs(n - m));
    const INF = Number.POSITIVE_INFINITY;
    let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1).fill(INF);
    let prevL = new Float64Array(m + 1), curL = new Float64Array(m + 1);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
        cur.fill(INF); curL.fill(0);
        const jLo = Math.max(1, i - w), jHi = Math.min(m, i + w);
        for (let j = jLo; j <= jHi; j++) {
            const c = dist(a[i - 1], b[j - 1]);
            let best = prev[j - 1], L = prevL[j - 1];
            if (prev[j] < best) { best = prev[j]; L = prevL[j]; }
            if (cur[j - 1] < best) { best = cur[j - 1]; L = curL[j - 1]; }
            cur[j] = c + best; curL[j] = L + 1;
        }
        [prev, cur] = [cur, prev]; [prevL, curL] = [curL, prevL];
    }
    return prev[m] / Math.max(1, prevL[m]);
}

/** Map a normalised DTW distance (progress units) to a 0..1 similarity. */
export function similarity(distance, scale = 0.25) {
    return Number.isFinite(distance) ? Math.exp(-distance / scale) : 0;
}

/**
 * Idealised default template: smooth rest -> target -> hold -> rest curve in
 * progress units. Replace with a physiotherapist-recorded reference
 * (collect.html -> "Save as reference") for real evaluations.
 */
export function idealTemplate(cfg, T = 30) {
    const holdFrac = Math.min(0.3, (cfg.holdMs || 0) / Math.max(1, (cfg.minRepMs + cfg.maxRepMs) / 2) + 0.1);
    const rise = (1 - holdFrac) / 2;
    const out = [];
    for (let i = 0; i < T; i++) {
        const x = i / (T - 1);
        let p;
        if (x < rise) p = 0.5 - 0.5 * Math.cos(Math.PI * x / rise);
        else if (x < rise + holdFrac) p = 1;
        else p = 0.5 + 0.5 * Math.cos(Math.PI * (x - rise - holdFrac) / rise);
        out.push(p);
    }
    return out;
}

/** Progress curve of a recorded repetition (frames with .metrics). */
export function progressCurve(cfg, frames) {
    return frames.map(f => progressOf(cfg, f.metrics[cfg.primaryMetric]));
}

export function resample1d(series, T = 30) {
    const N = series.length;
    if (!N) return [];
    return Array.from({ length: T }, (_, i) => {
        const pos = T === 1 ? 0 : i * (N - 1) / (T - 1);
        const lo = Math.floor(pos), hi = Math.min(lo + 1, N - 1), w = pos - lo;
        return series[lo] * (1 - w) + series[hi] * w;
    });
}

/** Compare a repetition against a template (array of progress values). */
export function compareToTemplate(cfg, frames, template) {
    const curve = resample1d(progressCurve(cfg, frames), template.length);
    const d = dtwDistance(curve, template, 0.25);
    return { distance: d, similarity: similarity(d) };
}
