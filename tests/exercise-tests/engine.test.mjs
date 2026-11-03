// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMediaPipe, normalizeFrame } from '../../js/rehabilitation/skeleton.js';
import { computeMetrics, angle3 } from '../../js/rehabilitation/angle-calculator.js';
import { EXERCISES, resolveExercise, progressOf } from '../../js/rehabilitation/exercise-configs.js';
import { RepetitionCounter } from '../../js/rehabilitation/repetition-counter.js';
import { evaluateFrame } from '../../js/rehabilitation/movement-evaluator.js';
import { RehabSession } from '../../js/rehabilitation/pose-engine.js';
import { repToFeatures, NUM_FEATURES, SEQ_LEN, phaseLabels } from '../../js/intelligence/feature-extractor.js';
import { dtwDistance, idealTemplate } from '../../js/intelligence/dtw-analyzer.js';
import { buildTwin } from '../../js/digital-twin/progress-model.js';
import { standingPose, setArm, setSquat, toResults, profile } from '../helpers/synthetic-pose.mjs';

const metricsOf = (P) => computeMetrics(normalizeFrame(fromMediaPipe(P, toResults(P).poseLandmarks).pts));

test('angle3 basic geometry', () => {
    assert.ok(Math.abs(angle3([1, 0, 0], [0, 0, 0], [0, 1, 0]) - 90) < 1e-9);
    assert.ok(Math.abs(angle3([1, 0, 0], [0, 0, 0], [-1, 0, 0]) - 180) < 1e-9);
});

test('normalisation is invariant to translation, scale and yaw', () => {
    const P = setArm(standingPose(), 'R', 70);
    const base = metricsOf(P);
    const th = 0.6;
    const moved = P.map(p => ({ ...p, x: 2.5 * (p.x * Math.cos(th) - p.z * Math.sin(th)) + 0.4, y: 2.5 * p.y - 0.1, z: 2.5 * (p.x * Math.sin(th) + p.z * Math.cos(th)) + 1 }));
    const m2 = metricsOf(moved);
    for (const k of ['shoulder_r', 'elbow_r', 'knee_l', 'trunk_incl', 'arm_plane_r']) {
        assert.ok(Math.abs(base[k] - m2[k]) < 1e-6, `${k}: ${base[k]} vs ${m2[k]}`);
    }
});

test('arm elevation and plane are measured correctly', () => {
    const side = metricsOf(setArm(standingPose(), 'R', 90, { plane: 0 }));
    // measured against the shoulder-hip line, which is ~9 deg off vertical in this pose
    assert.ok(Math.abs(side.shoulder_r - 90) < 10, `elevation ${side.shoulder_r}`);
    assert.ok(side.arm_plane_r < 10, `side plane ${side.arm_plane_r}`);
    const fwd = metricsOf(setArm(standingPose(), 'R', 90, { plane: 90 }));
    assert.ok(fwd.arm_plane_r > 80, `forward plane ${fwd.arm_plane_r}`);
    const elbow = metricsOf(setArm(standingPose(), 'R', 0, { elbowFlex: 90 }));
    assert.ok(Math.abs(elbow.elbow_r - 90) < 2, `elbow ${elbow.elbow_r}`);
});

test('squat knee angle and valgus rule', () => {
    const m = metricsOf(setSquat(standingPose(), 100));
    assert.ok(Math.abs(m.knee_mean - 100) < 2, `knee ${m.knee_mean}`);
    const v = metricsOf(setSquat(standingPose(), 100, { valgus: 0.07 }));
    assert.ok(evaluateFrame(EXERCISES.squat, v, 'hold').includes('knee_valgus'));
    assert.ok(!evaluateFrame(EXERCISES.squat, m, 'hold').includes('knee_valgus'));
});

test('repetition counter: complete, incomplete and jitter', () => {
    const cfg = EXERCISES.right_hand_raise;
    const c = new RepetitionCounter(cfg);
    let t = 0, events = [];
    const feed = (ps) => { for (const p of ps) { const e = c.update(p, t += 33); if (e) events.push(e); } };
    feed(profile(90).map(x => x * 1.1));                    // full rep, ~3 s
    feed(profile(60).map(x => x * 0.7));                    // partial rep
    feed(Array.from({ length: 60 }, (_, i) => 0.1 + 0.08 * Math.sin(i))); // jitter at rest
    assert.deepEqual(events.map(e => e.type), ['complete', 'incomplete']);
    assert.ok(events[0].rep.reachedTarget);
});

test('legacy exercise names resolve', () => {
    assert.equal(resolveExercise('Squat').id, 'squat');
    assert.equal(resolveExercise('Shoulder Abduction').id, 'shoulder_abduction');
    assert.equal(progressOf(EXERCISES.squat, 100), 1);
});

function runSession(exId, poseAt, nReps, { sets = 1 } = {}) {
    const cfg = EXERCISES[exId];
    const reps = [], events = [];
    const s = new RehabSession({ exercise: cfg, sets, reps: nReps, onRep: r => reps.push(r), onEvent: e => events.push(e) });
    let t = 0;
    for (let r = 0; r < nReps * sets; r++) {
        for (let i = 0; i < 20; i++) s.processResults(toResults(poseAt(0)), t += 33, 20);
        for (const x of profile(80)) s.processResults(toResults(poseAt(x)), t += 33, 20);
    }
    return { s, reps, events };
}

test('full session: shoulder abduction with correct form', () => {
    const { s, reps, events } = runSession('shoulder_abduction',
        x => { const P = standingPose(); setArm(P, 'L', 15 + 75 * x); setArm(P, 'R', 15 + 75 * x); return P; }, 3);
    assert.equal(reps.length, 3);
    assert.ok(reps.every(r => r.label === 'correct'), JSON.stringify(reps.map(r => [r.label, r.quality, r.errors])));
    assert.ok(events.some(e => e.type === 'session_complete'));
    const rec = s.buildRecord({ id: 'x', status: 'completed', prescription: { id: 'rx' }, startedAt: new Date(), endedAt: new Date() });
    assert.equal(rec.validReps, 3);
    assert.ok(rec.summary.rom.shoulder_l.bestRange > 60);
    assert.ok(JSON.stringify(rec).length < 100000);
});

test('full session: forward arm raise flagged in abduction', () => {
    const { reps } = runSession('shoulder_abduction',
        x => { const P = standingPose(); setArm(P, 'L', 15 + 75 * x, { plane: 70 }); setArm(P, 'R', 15 + 75 * x, { plane: 70 }); return P; }, 2);
    assert.ok(reps.length >= 1);
    assert.ok(reps.every(r => r.errors.some(e => e.id.startsWith('arm_forward'))));
    assert.ok(reps.every(r => r.label === 'incorrect'));
});

test('full session: squats across 2 sets', () => {
    const { reps, events } = runSession('squat', x => setSquat(standingPose(), 175 - 80 * x), 2, { sets: 2 });
    assert.equal(reps.filter(r => r.label !== 'incomplete').length, 4);
    assert.deepEqual(events.map(e => e.type), ['set_complete', 'session_complete']);
});

test('low-confidence frames are not scored', () => {
    const cfg = EXERCISES.squat;
    const s = new RehabSession({ exercise: cfg, sets: 1, reps: 1 });
    const P = standingPose(); P[27].visibility = 0.1;
    const st = s.processResults(toResults(P), 0, 0);
    assert.equal(st.valid, false);
    assert.match(st.message.text, /ankle|Step back/i);
});

test('feature sequence shape and phases', () => {
    const frames = profile(50).map(x => {
        const P = setArm(standingPose(), 'R', 20 + 130 * x);
        const f = fromMediaPipe(P, toResults(P).poseLandmarks);
        return { q: normalizeFrame(f.pts), vis: f.vis };
    });
    const X = repToFeatures(frames);
    assert.equal(X.length, SEQ_LEN);
    assert.equal(X[0].length, NUM_FEATURES);
    assert.equal(NUM_FEATURES, 82);
    const ph = phaseLabels(profile(30));
    assert.equal(ph[0], 0); assert.ok(ph.includes(1) && ph.includes(2) && ph.includes(3));
});

test('DTW: identical < shifted < different', () => {
    const t = idealTemplate(EXERCISES.squat);
    const slow = profile(45, 0.1);
    const flat = Array(30).fill(0.2);
    assert.equal(dtwDistance(t, t), 0);
    assert.ok(dtwDistance(t, slow) < dtwDistance(t, flat));
});

test('digital twin baseline and flags', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`, exerciseId: 'squat', status: 'completed', validReps: 10,
        startedAt: new Date(Date.now() - (8 - i) * 864e5),
        summary: { avgQuality: 80 - i * 4, rom: { knee_l: { bestRange: 60 + i * 2 } }, consistency: 90, symmetry: {} },
        feedback: { pain: i === 7 ? 8 : 3, difficulty: 'medium' },
    }));
    const twin = buildTwin(sessions);
    const sq = twin.exercises.squat;
    assert.equal(sq.sessions, 8);
    assert.ok(sq.baselineReady);
    assert.ok(sq.change.rom > 0);
    assert.ok(twin.flags.some(f => f.type === 'quality_decline'));
    assert.ok(twin.flags.some(f => f.type === 'high_pain'));
});
