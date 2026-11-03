// RehabSession: the rehabilitation intelligence engine for one exercise session.
// Per frame:  MediaPipe -> common skeleton -> validation -> One-Euro filter ->
//             normalisation -> metrics -> progress -> rep state machine ->
//             rule errors -> live feedback
// Per rep:    quality evaluation + DTW vs template + (optional) GRU/LSTM model
// UI-free: callbacks report everything, so it is testable in Node.
import { fromMediaPipe, normalizeFrame, NUM_JOINTS } from './skeleton.js';
import { computeMetrics } from './angle-calculator.js';
import { SkeletonFilter } from './movement-filter.js';
import { validateFrame, repositionMessage } from './landmark-validator.js';
import { progressOf } from './exercise-configs.js';
import { RepetitionCounter } from './repetition-counter.js';
import { evaluateFrame, frameFormScore, evaluateRep, round } from './movement-evaluator.js';
import { FeedbackEngine } from './feedback-engine.js';
import { compareToTemplate, idealTemplate } from '../intelligence/dtw-analyzer.js';
import { repToFeatures } from '../intelligence/feature-extractor.js';
import { summarizeSession } from '../intelligence/rehabilitation-analytics.js';

const PREROLL_MS = 400;
const MAX_REP_FRAMES = 900;

export class RehabSession {
    /**
     * @param {object} o
     * @param {object} o.exercise   exercise config
     * @param {number} o.sets
     * @param {number} o.reps       reps per set
     * @param {number[]} [o.template] DTW reference (progress curve); defaults to idealised
     * @param {object} [o.classifier] MovementClassifier or null
     * @param {boolean} [o.voice]
     * @param {(s:object)=>void} [o.onFrame] live state per frame
     * @param {(r:object)=>void} [o.onRep]   evaluated repetition
     * @param {(e:object)=>void} [o.onEvent] set_complete / session_complete / rep_aborted
     * @param {boolean} [o.recordFeatures] keep per-rep feature sequences (research mode)
     */
    constructor(o) {
        this.cfg = o.exercise;
        this.sets = o.sets; this.repsPerSet = o.reps;
        this.template = o.template || idealTemplate(this.cfg);
        this.templateSource = o.template ? (o.templateSource || 'custom') : 'idealised';
        this.classifier = o.classifier || null;
        this.onFrame = o.onFrame || (() => {}); this.onRep = o.onRep || (() => {}); this.onEvent = o.onEvent || (() => {});
        this.recordFeatures = !!o.recordFeatures;
        this.feedback = new FeedbackEngine({ voice: !!o.voice });
        this.filter = new SkeletonFilter(NUM_JOINTS, 3, { minCutoff: 1.0, beta: 0.05 });
        this.counter = new RepetitionCounter(this.cfg);
        this.reps = [];
        this.currentSet = 1; this.repsInSet = 0;
        this.preroll = []; this.repFrames = [];
        this.stats = { frames: 0, lowConfidenceFrames: 0, latencySum: 0, startT: null, lastT: null, mlLatencySum: 0, mlCount: 0 };
        this.finished = false;
    }

    get validReps() { return this.reps.filter(r => r.label !== 'incomplete').length; }

    /** Feed one MediaPipe result. tMs = capture timestamp, latencyMs = inference time. */
    processResults(results, tMs, latencyMs = 0) {
        if (this.finished) return null;
        const s = this.stats;
        if (s.startT === null) s.startT = tMs;
        s.lastT = tMs; s.frames++; s.latencySum += latencyMs;

        const has = results && results.poseLandmarks && results.poseLandmarks.length >= 33;
        const frame = has ? fromMediaPipe(results.poseWorldLandmarks, results.poseLandmarks) : null;
        const v = validateFrame(frame, this.cfg.requiredJoints);
        if (!v.ok) {
            s.lowConfidenceFrames++;
            const ev = this.counter.update(0, tMs, false);
            if (ev && ev.type === 'aborted') { this.repFrames = []; this.onEvent({ type: 'rep_aborted' }); }
            const msg = this.feedback.frameMessage(this.cfg, { valid: false, reposition: has ? repositionMessage(v.missing) : 'No person detected - step into view' }, tMs);
            const state = { valid: false, confidence: v.confidence, missing: v.missing, phase: this.counter.state, message: msg, formScore: 0, progress: null, metrics: null, landmarks: results?.poseLandmarks || null };
            this.onFrame(state);
            return state;
        }

        const pts = this.filter.filter(frame.pts, tMs / 1000);
        const q = normalizeFrame(pts);
        const metrics = computeMetrics(q);
        const progress = progressOf(this.cfg, metrics[this.cfg.primaryMetric]);
        const ev = this.counter.update(progress, tMs, true);
        const phase = this.counter.state;
        const errors = evaluateFrame(this.cfg, metrics, phase);
        const rec = { t: tMs, q, vis: frame.vis, metrics, phase, errors };
        if (this.recordFeatures) rec.raw = frame.pts;   // unfiltered, un-normalised (research export)

        // keep frames for the current repetition (with a short rest pre-roll)
        if (this.counter.rep || ev) {
            if (!this.repFrames.length) this.repFrames = this.preroll.slice();
            if (this.repFrames.length < MAX_REP_FRAMES) this.repFrames.push(rec);
        } else {
            this.repFrames = [];            // movement too small to count: discard
            this.preroll.push(rec);
            while (this.preroll.length && tMs - this.preroll[0].t > PREROLL_MS) this.preroll.shift();
        }
        if (ev) this._handleRepEvent(ev);

        const msg = this.feedback.frameMessage(this.cfg, { valid: true, phase, errors }, tMs);
        const state = {
            valid: true, confidence: v.confidence, phase, progress, errors, metrics, message: msg,
            formScore: round(frameFormScore(this.cfg, errors, v.confidence)),
            landmarks: results.poseLandmarks,
            currentSet: this.currentSet, repsInSet: this.repsInSet,
        };
        this.onFrame(state);
        return state;
    }

    _handleRepEvent(ev) {
        const frames = this.repFrames; this.repFrames = []; this.preroll = [];
        if (ev.type === 'aborted') { this.onEvent({ type: 'rep_aborted' }); return; }
        const rep = { ...ev.rep, frames };
        const dtw = frames.length >= 3 ? compareToTemplate(this.cfg, frames, this.template) : { distance: null, similarity: null };
        const evald = evaluateRep(this.cfg, rep, dtw.similarity);

        let ml = null;
        if (this.classifier && frames.length >= 5) {
            try {
                const pred = this.classifier.predict(repToFeatures(frames));
                this.stats.mlLatencySum += pred.latencyMs; this.stats.mlCount++;
                ml = {
                    exercise: pred.exercise.id, exerciseProb: round(pred.exercise.prob, 3),
                    quality: pred.quality.label, qualityProb: round(pred.quality.prob, 3),
                    confident: pred.quality.prob >= 0.6 && (this.classifier.qualityReliable?.(this.cfg.id) ?? true),
                    exerciseMismatch: pred.exercise.prob >= 0.7 && pred.exercise.id !== (this.classifier.modelClassFor?.(this.cfg.id) ?? this.cfg.id),
                };
            } catch (e) { console.warn('ML inference failed', e); }
        }

        const record = {
            index: this.reps.length + 1,
            set: this.currentSet,
            label: evald.label,
            quality: evald.quality,
            durationMs: Math.round(rep.durationMs),
            holdMs: Math.round(rep.holdMs),
            peak: round(rep.peak, 3),
            rom: evald.rom,
            symmetry: evald.symmetry,
            errors: evald.errors.map(e => ({ id: e.id, fraction: e.fraction, severity: e.severity })),
            components: evald.components,
            dtwDistance: dtw.distance === null ? null : round(dtw.distance, 4),
            ml,
        };
        if (this.recordFeatures) record._frames = frames.map(f => ({ t: f.t, q: f.q, vis: f.vis, raw: f.raw, metrics: f.metrics }));
        this.reps.push(record);

        if (record.label !== 'incomplete') {
            this.repsInSet++;
            this.feedback.announce(`${this.repsInSet}`);
        }
        this.onRep({ ...record, messages: evald.errors.map(e => e.message) });

        if (this.repsInSet >= this.repsPerSet) {
            if (this.currentSet >= this.sets) {
                this.finished = true;
                this.feedback.announce('Exercise complete. Well done!');
                this.onEvent({ type: 'session_complete' });
            } else {
                this.onEvent({ type: 'set_complete', set: this.currentSet });
                this.feedback.announce(`Set ${this.currentSet} complete`);
                this.currentSet++; this.repsInSet = 0;
            }
        }
    }

    setVoice(on) { this.feedback.setVoice(on); }

    /** Build the standardised session record (see documentation/data-model.md). */
    buildRecord({ id, status, prescription, startedAt, endedAt }) {
        const s = this.stats;
        const durS = s.startT !== null ? (s.lastT - s.startT) / 1000 : 0;
        const summary = summarizeSession(this.cfg, this.reps, {
            fps: durS > 0 ? round(s.frames / durS, 1) : 0,
            avgPoseLatencyMs: s.frames ? round(s.latencySum / s.frames, 1) : 0,
            avgModelLatencyMs: s.mlCount ? round(s.mlLatencySum / s.mlCount, 2) : null,
            lowConfidencePct: s.frames ? round(100 * s.lowConfidenceFrames / s.frames, 1) : 0,
            templateSource: this.templateSource,
            mlModel: this.classifier ? this.classifier.info.model_name : null,
        });
        return {
            id,
            status,
            prescriptionId: prescription?.id || null,
            exerciseId: this.cfg.id,
            exercise: this.cfg.name,
            targetSets: this.sets,
            targetReps: this.repsPerSet,
            setsCompleted: this.finished ? this.sets : this.currentSet - 1,
            validReps: summary.validReps,
            incompleteReps: summary.incompleteReps,
            reps: this.reps.slice(0, 500).map(({ _frames, ...r }) => r),
            summary,
            startedAt, endedAt,
            engineVersion: '2.0.0',
            feedback: null,
        };
    }
}
