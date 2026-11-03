// Filtered finite-state machine for repetition segmentation.
//   rest -> outward -> hold -> return -> rest   (complete repetition)
//   rest -> outward -> rest                     (incomplete if it got past `partial`)
// Works on "progress": 0 = rest position, 1 = prescribed target, for any
// exercise and either direction of movement. Hysteresis between the entry
// and exit thresholds suppresses jitter-induced double counts, replacing the
// old fixed 1-second debounce. Mirrored in ml/meditask_ml/segmentation.py.
import { REP_THRESHOLDS } from './exercise-configs.js';

export const PHASES = ['rest', 'outward', 'hold', 'return'];

export class RepetitionCounter {
    constructor(cfg, thresholds = REP_THRESHOLDS) {
        this.cfg = cfg;
        this.th = thresholds;
        this.reset();
    }

    reset() {
        this.state = 'rest';
        this.rep = null;
        this.lostSince = null;
    }

    /**
     * @param {number} p progress (0 rest .. 1 target)
     * @param {number} t timestamp in ms
     * @param {boolean} valid whether this frame passed confidence validation
     * @returns {null | {type:'complete'|'incomplete'|'aborted', rep:object}}
     */
    update(p, t, valid = true) {
        const th = this.th;
        if (!valid) {
            if (this.state !== 'rest') {
                if (this.lostSince === null) this.lostSince = t;
                if (t - this.lostSince > th.abortMs) {
                    const rep = this.rep;
                    this.reset();
                    return { type: 'aborted', rep };
                }
            }
            return null;
        }
        this.lostSince = null;
        if (this.rep) {
            this.rep.peak = Math.max(this.rep.peak, p);
            if (this.state === 'hold') this.rep.holdMs += Math.max(0, t - this.rep.lastT);
            this.rep.lastT = t;
        }

        switch (this.state) {
            case 'rest':
                if (p > th.enter) {
                    this.state = 'outward';
                    this.rep = { startT: t, lastT: t, peak: p, reachedTarget: false, holdMs: 0, targetT: null };
                }
                break;
            case 'outward':
                if (p >= th.target) {
                    this.state = 'hold';
                    this.rep.reachedTarget = true;
                    this.rep.targetT = t;
                } else if (p < th.rest) {
                    const rep = this._close(t);
                    this.state = 'rest';
                    if (rep.peak >= th.partial) return { type: 'incomplete', rep };
                }
                break;
            case 'hold':
                if (p < th.holdExit) this.state = 'return';
                break;
            case 'return':
                if (p >= th.target) this.state = 'hold';
                else if (p < th.rest) {
                    const rep = this._close(t);
                    this.state = 'rest';
                    return { type: 'complete', rep };
                }
                break;
        }
        return null;
    }

    _close(t) {
        const rep = this.rep;
        this.rep = null;
        rep.endT = t;
        rep.durationMs = t - rep.startT;
        const flags = [];
        if (rep.reachedTarget) {
            if (rep.durationMs < this.cfg.minRepMs) flags.push('too_fast');
            if (rep.durationMs > this.cfg.maxRepMs) flags.push('too_slow');
            if (rep.holdMs + 1 < (this.cfg.holdMs || 0)) flags.push('short_hold');
        } else {
            flags.push('incomplete_rom');
        }
        rep.flags = flags;
        return rep;
    }
}
