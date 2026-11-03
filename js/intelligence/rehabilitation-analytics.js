// Session-level analytics: ROM achieved, symmetry, consistency, error
// breakdown and an EXPERIMENTAL within-session performance-decline
// ("fatigue") indicator. None of these are validated clinical measures.
import { round } from '../rehabilitation/movement-evaluator.js';

export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
export function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }

/** Least-squares slope of y over index. */
export function slope(y) {
    const n = y.length; if (n < 2) return 0;
    const xm = (n - 1) / 2, ym = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - xm) * (y[i] - ym); den += (i - xm) ** 2; }
    return den ? num / den : 0;
}

/**
 * @param {object} cfg exercise config
 * @param {object[]} reps evaluated repetitions [{label, quality, durationMs, rom, symmetry, errors, peak}]
 */
export function summarizeSession(cfg, reps, stats = {}) {
    const valid = reps.filter(r => r.label !== 'incomplete');
    const qualities = valid.map(r => r.quality);
    const durations = valid.map(r => r.durationMs);

    const romPeak = {};
    for (const k of cfg.romJoints) {
        const ranges = valid.map(r => r.rom?.[k]?.range).filter(Number.isFinite);
        const mins = valid.map(r => r.rom?.[k]?.min).filter(Number.isFinite);
        const maxs = valid.map(r => r.rom?.[k]?.max).filter(Number.isFinite);
        if (ranges.length) romPeak[k] = { bestRange: round(Math.max(...ranges), 1), meanRange: round(mean(ranges), 1), min: round(Math.min(...mins), 1), max: round(Math.max(...maxs), 1) };
    }

    const symmetry = {};
    for (const [a, b] of cfg.bilateralPairs || []) {
        const key = `${a}|${b}`;
        const v = valid.map(r => r.symmetry?.[key]).filter(Number.isFinite);
        if (v.length) symmetry[key] = round(mean(v), 1);
    }

    const errorCounts = {};
    for (const r of reps) for (const e of r.errors || []) errorCounts[e.id] = (errorCounts[e.id] || 0) + 1;

    // Consistency: 100 - coefficient of variation of the primary-metric range.
    const primaryRanges = valid.map(r => r.rom?.[cfg.romJoints[0]]?.range).filter(Number.isFinite);
    const cv = primaryRanges.length > 1 ? std(primaryRanges) / Math.max(1e-6, mean(primaryRanges)) : 0;
    const consistency = round(Math.max(0, 100 - cv * 100), 1);

    // Experimental decline indicator: negative quality slope + lengthening reps.
    const qSlope = slope(qualities);
    const dSlope = slope(durations);
    const decline = valid.length >= 5 && qSlope < -1.5 && dSlope > 50;

    return {
        totalReps: reps.length,
        validReps: valid.length,
        correctReps: reps.filter(r => r.label === 'correct').length,
        incompleteReps: reps.filter(r => r.label === 'incomplete').length,
        avgQuality: round(mean(qualities), 1),
        avgDurationMs: Math.round(mean(durations)),
        rom: romPeak,
        symmetry,
        consistency,
        errorCounts,
        qualitySlopePerRep: round(qSlope, 2),
        performanceDecline: decline,
        ...stats,
    };
}
