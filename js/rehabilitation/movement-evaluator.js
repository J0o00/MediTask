// Explainable movement evaluation.
// Frame level: declarative biomechanical rules -> active error codes + form score.
// Repetition level: movement QUALITY score (not "clinical accuracy") built from
// range of motion, persistent errors, tempo, smoothness and DTW similarity.
// Mirrored in ml/meditask_ml/rules.py for the rule-based experimental baseline.

const ERROR_PERSISTENCE = 0.25;   // an error must be present in >=25% of applicable frames

const FLAG_INFO = {
    too_fast: { severity: 1, message: 'Slow down - move with control' },
    too_slow: { severity: 1, message: 'Try a steadier, continuous pace' },
    short_hold: { severity: 1, message: 'Hold the end position a little longer' },
    incomplete_rom: { severity: 2, message: 'Move through the full prescribed range' },
};

export function ruleActive(rule, m) {
    const a = m[rule.metric];
    if (a === undefined || a === null || Number.isNaN(a)) return false;
    if (rule.metric.startsWith('arm_plane') && a < 0) return false;   // plane undefined (arm vertical)
    switch (rule.op) {
        case '<': return a < rule.value;
        case '>': return a > rule.value;
        case 'absdiff>': {
            const b = m[rule.metricB];
            return b !== undefined && Math.abs(a - b) > rule.value;
        }
        default: return false;
    }
}

/** @returns {string[]} ids of rules violated in this frame */
export function evaluateFrame(cfg, metrics, phase) {
    const out = [];
    for (const r of cfg.rules) {
        if (r.phases && !r.phases.includes(phase)) continue;
        if (ruleActive(r, metrics)) out.push(r.id);
    }
    return out;
}

/** Instantaneous form score for the live gauge (0-100). */
export function frameFormScore(cfg, errors, confidence = 1) {
    let penalty = 0;
    for (const id of errors) {
        const r = cfg.rules.find(x => x.id === id);
        penalty += (r?.severity || 1) * 15;
    }
    return Math.max(0, Math.min(100, (100 - penalty) * Math.min(1, confidence / 0.8)));
}

export function ruleMessage(cfg, id) {
    return cfg.rules.find(r => r.id === id)?.message || FLAG_INFO[id]?.message || id;
}

function countReversals(series, minStep = 0.5) {
    let last = 0, changes = 0;
    for (let i = 1; i < series.length; i++) {
        const d = series[i] - series[i - 1];
        if (Math.abs(d) < minStep) continue;
        const s = Math.sign(d);
        if (last !== 0 && s !== last) changes++;
        last = s;
    }
    return changes;
}

/**
 * Score one repetition.
 * @param {object} cfg exercise config
 * @param {object} rep from RepetitionCounter (+ rep.frames: [{metrics, phase, errors}])
 * @param {number|null} dtwSimilarity 0..1 similarity to the reference template
 */
export function evaluateRep(cfg, rep, dtwSimilarity = null) {
    const frames = rep.frames || [];
    // --- persistent errors (explainable) ---
    const errors = [];
    for (const r of cfg.rules) {
        const applicable = frames.filter(f => !r.phases || r.phases.includes(f.phase));
        if (!applicable.length) continue;
        const frac = applicable.filter(f => f.errors.includes(r.id)).length / applicable.length;
        if (frac >= ERROR_PERSISTENCE) errors.push({ id: r.id, fraction: round(frac, 2), severity: r.severity, message: r.message });
    }
    for (const f of rep.flags || []) errors.push({ id: f, fraction: 1, severity: FLAG_INFO[f].severity, message: FLAG_INFO[f].message });

    // --- range of motion per joint ---
    const rom = {};
    for (const k of cfg.romJoints) {
        const vals = frames.map(f => f.metrics[k]).filter(v => Number.isFinite(v));
        if (vals.length) rom[k] = { min: round(Math.min(...vals), 1), max: round(Math.max(...vals), 1), range: round(Math.max(...vals) - Math.min(...vals), 1) };
    }
    // --- bilateral symmetry (mean absolute L-R difference while moving) ---
    const symmetry = {};
    for (const [a, b] of cfg.bilateralPairs || []) {
        const active = frames.filter(f => f.phase !== 'rest');
        if (active.length) symmetry[`${a}|${b}`] = round(active.reduce((s, f) => s + Math.abs(f.metrics[a] - f.metrics[b]), 0) / active.length, 1);
    }

    // --- component scores ---
    const romScore = Math.min(1, Math.max(0, rep.peak)) * 100;
    let penalty = 0;
    for (const e of errors) penalty += Math.min(1, e.fraction * 2) * e.severity * 10;
    const errorScore = Math.max(0, 100 - penalty);
    const d = rep.durationMs || 0;
    let tempoScore = 100;
    if (d < cfg.minRepMs) tempoScore = 100 * d / cfg.minRepMs;
    else if (d > cfg.maxRepMs) tempoScore = Math.max(0, 100 - 100 * (d - cfg.maxRepMs) / cfg.maxRepMs);
    const reversals = countReversals(frames.map(f => f.metrics[cfg.primaryMetric]));
    const smoothScore = Math.max(0, 100 - 25 * Math.max(0, reversals - 1));

    const parts = [[romScore, 0.35], [errorScore, 0.35], [tempoScore, 0.1], [smoothScore, 0.1]];
    if (dtwSimilarity !== null && Number.isFinite(dtwSimilarity)) parts.push([dtwSimilarity * 100, 0.1]);
    const wsum = parts.reduce((s, [, w]) => s + w, 0);
    const quality = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;

    // 'correct' requires good overall quality AND no persistent moderate/major error.
    const label = !rep.reachedTarget ? 'incomplete' : (quality >= 75 && !errors.some(e => e.severity >= 2) ? 'correct' : 'incorrect');
    return {
        quality: round(quality, 1),
        label,
        errors,
        rom,
        symmetry,
        components: { rom: round(romScore, 1), errors: round(errorScore, 1), tempo: round(tempoScore, 1), smoothness: round(smoothScore, 1), dtw: dtwSimilarity === null ? null : round(dtwSimilarity * 100, 1) },
        reversals,
    };
}

export function round(v, d = 0) { const k = 10 ** d; return Math.round(v * k) / k; }
