// Digital Rehabilitation Twin (data-driven, no avatar).
// A longitudinal, patient-specific model of rehabilitation status, rebuilt
// from the standardised session records - a single source of truth, so
// there is no separate twin document to drift out of sync.
//
//  - per-exercise timeline of ROM, movement quality, symmetry, pain
//  - personal baseline = first BASELINE_SESSIONS completed sessions
//  - change vs baseline and recent trend (least-squares slope)
//  - review flags for the physiotherapist (never treatment decisions)
import { mean, slope } from '../intelligence/rehabilitation-analytics.js';
import { resolveExercise } from '../rehabilitation/exercise-configs.js';
import { round } from '../rehabilitation/movement-evaluator.js';

export const BASELINE_SESSIONS = 3;
const RECENT = 5;

const toDate = (ts) => ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : (ts ? new Date(ts) : null));

/**
 * @param {object[]} sessions session records (any order)
 * @returns {object} twin
 */
export function buildTwin(sessions) {
    const done = sessions
        .filter(s => s && s.summary && (s.status === 'completed' || s.status === 'stopped'))
        .map(s => ({ ...s, _date: toDate(s.startedAt) }))
        .filter(s => s._date)
        .sort((a, b) => a._date - b._date);

    const byExercise = {};
    for (const s of done) (byExercise[s.exerciseId] ||= []).push(s);

    const exercises = {};
    const flags = [];
    for (const [exId, list] of Object.entries(byExercise)) {
        const cfg = resolveExercise(exId);
        const primary = cfg?.romJoints?.[0];
        const timeline = list.map(s => ({
            date: s._date.toISOString(),
            sessionId: s.id,
            quality: s.summary.avgQuality ?? null,
            rom: primary ? (s.summary.rom?.[primary]?.bestRange ?? null) : null,
            romByJoint: Object.fromEntries(Object.entries(s.summary.rom || {}).map(([k, v]) => [k, v.bestRange])),
            symmetry: firstValue(s.summary.symmetry),
            consistency: s.summary.consistency ?? null,
            pain: s.feedback?.pain ?? null,
            validReps: s.validReps ?? 0,
            decline: !!s.summary.performanceDecline,
        }));

        const base = timeline.slice(0, BASELINE_SESSIONS);
        const recent = timeline.slice(-RECENT);
        const metric = (arr, k) => arr.map(x => x[k]).filter(Number.isFinite);
        const baseline = { quality: avg(metric(base, 'quality')), rom: avg(metric(base, 'rom')), pain: avg(metric(base, 'pain')), symmetry: avg(metric(base, 'symmetry')) };
        const current = { quality: avg(metric(recent, 'quality')), rom: avg(metric(recent, 'rom')), pain: avg(metric(recent, 'pain')), symmetry: avg(metric(recent, 'symmetry')) };
        const trend = { quality: round(slope(metric(recent, 'quality')), 2), rom: round(slope(metric(recent, 'rom')), 2), pain: round(slope(metric(recent, 'pain')), 2) };
        const change = {
            quality: diff(current.quality, baseline.quality),
            rom: diff(current.rom, baseline.rom),
            pain: diff(current.pain, baseline.pain),
            symmetry: diff(current.symmetry, baseline.symmetry),
        };

        const name = cfg?.name || exId;
        if (timeline.length >= BASELINE_SESSIONS + 2) {
            if (trend.quality < -2) flags.push({ exerciseId: exId, type: 'quality_decline', message: `${name}: movement quality declining over recent sessions` });
            if (trend.rom < -2) flags.push({ exerciseId: exId, type: 'rom_decline', message: `${name}: range of motion decreasing over recent sessions` });
        }
        const lastPain = timeline.at(-1)?.pain;
        if (Number.isFinite(lastPain) && lastPain >= 7) flags.push({ exerciseId: exId, type: 'high_pain', message: `${name}: last reported pain ${lastPain}/10` });
        if (trend.pain > 0.75 && metric(recent, 'pain').length >= 3) flags.push({ exerciseId: exId, type: 'pain_rising', message: `${name}: reported pain rising` });

        exercises[exId] = {
            exerciseId: exId, name, primaryJoint: primary || null,
            sessions: timeline.length, timeline, baseline, current, change, trend,
            baselineReady: timeline.length >= BASELINE_SESSIONS,
        };
    }

    // adherence over the last 14 days (days with at least one session)
    const since = Date.now() - 14 * 864e5;
    const activeDays = new Set(done.filter(s => s._date.getTime() >= since).map(s => s._date.toISOString().slice(0, 10)));
    return {
        generatedAt: new Date().toISOString(),
        totalSessions: done.length,
        activeDaysLast14: activeDays.size,
        exercises,
        flags,
    };
}

/** The patient's highest-quality session for an exercise (shown as "personal best"). */
export function bestSession(sessions, exerciseId) {
    return sessions.filter(s => s.exerciseId === exerciseId && s.summary)
        .sort((a, b) => (b.summary.avgQuality || 0) - (a.summary.avgQuality || 0))[0] || null;
}

function avg(a) { return a.length ? round(mean(a), 1) : null; }
function diff(a, b) { return a === null || b === null ? null : round(a - b, 1); }
function firstValue(o) { const v = o ? Object.values(o)[0] : undefined; return Number.isFinite(v) ? v : null; }
