// Chooses one clear instruction per moment and (optionally) speaks it.
// Priority: safety/visibility > highest-severity active error > phase cue.
import { ruleMessage } from './movement-evaluator.js';

export class FeedbackEngine {
    constructor({ voice = false, lang = 'en-IN', minGapMs = 3500 } = {}) {
        this.voice = voice && typeof window !== 'undefined' && 'speechSynthesis' in window;
        this.lang = lang;
        this.minGapMs = minGapMs;
        this.lastSpoken = '';
        this.lastSpokenAt = 0;
        this.errorSince = {};   // debounce: only surface errors that persist ~300 ms
    }

    setVoice(on) { this.voice = on && typeof window !== 'undefined' && 'speechSynthesis' in window; if (!this.voice) this.cancel(); }

    /**
     * @returns {{text:string, level:'info'|'warn'|'error'|'good'}}
     */
    frameMessage(cfg, { valid, reposition, phase, errors }, t) {
        if (!valid) return this._out({ text: reposition || 'Position yourself in front of the camera', level: 'error' }, t);
        const now = t;
        for (const id of Object.keys(this.errorSince)) if (!errors.includes(id)) delete this.errorSince[id];
        for (const id of errors) if (!(id in this.errorSince)) this.errorSince[id] = now;
        const persistent = errors.filter(id => now - this.errorSince[id] > 300);
        if (persistent.length) {
            const worst = persistent
                .map(id => ({ id, sev: cfg.rules.find(r => r.id === id)?.severity || 1 }))
                .sort((a, b) => b.sev - a.sev)[0];
            return this._out({ text: ruleMessage(cfg, worst.id), level: worst.sev >= 2 ? 'warn' : 'info' }, t);
        }
        return this._out({ text: cfg.cues?.[phase] || 'Keep going', level: phase === 'hold' ? 'good' : 'info' }, t, false);
    }

    announce(text, t = Date.now()) { this.say(text, t, true); }

    _out(msg, t, speak = true) {
        if (speak) this.say(msg.text, t);
        return msg;
    }

    say(text, t = Date.now(), force = false) {
        if (!this.voice || !text) return;
        if (!force && (text === this.lastSpoken || t - this.lastSpokenAt < this.minGapMs)) return;
        try {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang = this.lang; u.rate = 1.0;
            window.speechSynthesis.speak(u);
            this.lastSpoken = text; this.lastSpokenAt = t;
        } catch (e) { /* speech is best-effort */ }
    }

    cancel() { try { window.speechSynthesis?.cancel(); } catch (e) { /* ignore */ } }
}
