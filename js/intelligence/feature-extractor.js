// Temporal feature extraction for the LSTM/GRU model.
// One sample = one repetition resampled to SEQ_LEN frames x NUM_FEATURES.
// Must stay numerically identical to ml/meditask_ml/features.py
// (verified by tests/parity/feature-parity.test.mjs).
import { NUM_JOINTS } from '../rehabilitation/skeleton.js';
import { computeMetrics, FEATURE_ANGLES } from '../rehabilitation/angle-calculator.js';

export const SEQ_LEN = 30;
export const SYMMETRY_PAIRS = [['elbow_l', 'elbow_r'], ['shoulder_l', 'shoulder_r'], ['hip_l', 'hip_r'], ['knee_l', 'knee_r']];
// 36 coords + 10 angles + 10 velocities + 10 accelerations + 4 symmetry + 12 visibility
export const NUM_FEATURES = NUM_JOINTS * 3 + FEATURE_ANGLES.length * 3 + SYMMETRY_PAIRS.length + NUM_JOINTS;
export const PHASE_LABELS = ['rest', 'outward', 'hold', 'return'];

export function featureNames() {
    const names = [];
    for (let j = 0; j < NUM_JOINTS; j++) for (const ax of ['x', 'y', 'z']) names.push(`j${j}_${ax}`);
    for (const a of FEATURE_ANGLES) names.push(a);
    for (const a of FEATURE_ANGLES) names.push(`d_${a}`);
    for (const a of FEATURE_ANGLES) names.push(`dd_${a}`);
    for (const [a] of SYMMETRY_PAIRS) names.push(`sym_${a.split('_')[0]}`);
    for (let j = 0; j < NUM_JOINTS; j++) names.push(`vis_${j}`);
    return names;
}

/**
 * Linear resampling by frame index.
 * @param {{q:number[][], vis:number[]}[]} frames normalised frames
 */
export function resampleFrames(frames, T = SEQ_LEN) {
    const N = frames.length;
    if (N === 0) throw new Error('empty sequence');
    const out = [];
    for (let i = 0; i < T; i++) {
        const pos = T === 1 ? 0 : i * (N - 1) / (T - 1);
        const lo = Math.floor(pos), hi = Math.min(lo + 1, N - 1), w = pos - lo;
        const A = frames[lo], B = frames[hi];
        const q = A.q.map((p, j) => p.map((v, d) => v * (1 - w) + B.q[j][d] * w));
        const vis = A.vis.map((v, j) => v * (1 - w) + B.vis[j] * w);
        out.push({ q, vis });
    }
    return out;
}

/** @returns {number[][]} T x NUM_FEATURES */
export function buildFeatureSequence(resampled) {
    const seq = [];
    let prevA = null, prevV = null;
    for (const fr of resampled) {
        const m = computeMetrics(fr.q);
        const a = FEATURE_ANGLES.map(k => m[k] / 180);
        const v = prevA ? a.map((x, i) => x - prevA[i]) : a.map(() => 0);
        const acc = prevV ? v.map((x, i) => x - prevV[i]) : v.map(() => 0);
        const sym = SYMMETRY_PAIRS.map(([l, r]) => Math.abs(m[l] - m[r]) / 180);
        const row = [];
        for (const p of fr.q) row.push(p[0], p[1], p[2]);
        row.push(...a, ...v, ...acc, ...sym, ...fr.vis);
        seq.push(row);
        prevA = a; prevV = v;
    }
    return seq;
}

export function repToFeatures(frames, T = SEQ_LEN) {
    return buildFeatureSequence(resampleFrames(frames, T));
}

/**
 * Weak per-frame phase labels from the primary metric trajectory.
 * Used both to label public datasets (which have no phase annotation) and
 * as the reference for the model's phase head.
 */
export function phaseLabels(series) {
    const start = series[0];
    let k = 0, amp = 0;
    series.forEach((v, i) => { const d = Math.abs(v - start); if (d > amp) { amp = d; k = i; } });
    if (amp < 1e-6) return series.map(() => 0);
    return series.map((v, t) => {
        const p = Math.abs(v - start) / amp;
        if (p >= 0.85) return 2;
        if (p < 0.15) return 0;
        return t <= k ? 1 : 3;
    });
}
