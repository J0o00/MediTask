// In-browser inference for the MediTask temporal model (GRU or LSTM,
// multi-task: exercise + movement quality + per-frame phase).
//
// The model is exported by ml/meditask_ml/export_web.py as:
//   models/web/meditask_model.json  - architecture, labels, feature stats, layer shapes
//   models/web/meditask_model.bin   - float32 weights (little-endian)
// The forward pass is implemented here directly (≈5 M multiply-adds per
// repetition) so there is no TensorFlow.js / converter dependency, no network
// latency, and predictions can be checked against Keras in Node
// (tests/parity/model-parity.test.mjs).
// Without a trained model the app runs in rule-based mode.

const sigmoid = x => 1 / (1 + Math.exp(-x));

function dense(x, W, b, inDim, outDim, act = null) {
    const y = new Float32Array(outDim);
    for (let o = 0; o < outDim; o++) {
        let s = b[o];
        for (let i = 0; i < inDim; i++) s += x[i] * W[i * outDim + o];
        y[o] = act === 'relu' ? Math.max(0, s) : s;
    }
    return y;
}

function softmax(v) {
    const m = Math.max(...v);
    const e = Array.from(v, x => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map(x => x / s);
}

/** Keras GRU (reset_after=True). kernel [in,3u] gates z|r|h, bias [2,3u]. */
function gruSequence(seq, L) {
    const u = L.units, inDim = L.inputDim, K = L.kernel, R = L.recurrent, B = L.bias;
    let h = new Float32Array(u);
    const out = [];
    for (const x of seq) {
        const xz = new Float32Array(3 * u), hz = new Float32Array(3 * u);
        for (let g = 0; g < 3 * u; g++) {
            let s = B[g];
            for (let i = 0; i < inDim; i++) s += x[i] * K[i * 3 * u + g];
            xz[g] = s;
            let r = B[3 * u + g];
            for (let i = 0; i < u; i++) r += h[i] * R[i * 3 * u + g];
            hz[g] = r;
        }
        const hn = new Float32Array(u);
        for (let k = 0; k < u; k++) {
            const z = sigmoid(xz[k] + hz[k]);
            const r = sigmoid(xz[u + k] + hz[u + k]);
            const c = Math.tanh(xz[2 * u + k] + r * hz[2 * u + k]);
            hn[k] = z * h[k] + (1 - z) * c;
        }
        h = hn; out.push(h);
    }
    return out;
}

/** Keras LSTM. kernel [in,4u] gates i|f|c|o, bias [4u]. */
function lstmSequence(seq, L) {
    const u = L.units, inDim = L.inputDim, K = L.kernel, R = L.recurrent, B = L.bias;
    let h = new Float32Array(u), c = new Float32Array(u);
    const out = [];
    for (const x of seq) {
        const g = new Float32Array(4 * u);
        for (let j = 0; j < 4 * u; j++) {
            let s = B[j];
            for (let i = 0; i < inDim; i++) s += x[i] * K[i * 4 * u + j];
            for (let i = 0; i < u; i++) s += h[i] * R[i * 4 * u + j];
            g[j] = s;
        }
        const hn = new Float32Array(u), cn = new Float32Array(u);
        for (let k = 0; k < u; k++) {
            const ig = sigmoid(g[k]), fg = sigmoid(g[u + k]), cc = Math.tanh(g[2 * u + k]), og = sigmoid(g[3 * u + k]);
            cn[k] = fg * c[k] + ig * cc;
            hn[k] = og * Math.tanh(cn[k]);
        }
        h = hn; c = cn; out.push(h);
    }
    return out;
}

export class MovementClassifier {
    constructor(manifest, buffer) {
        this.m = manifest;
        const f32 = new Float32Array(buffer);
        const take = (spec) => f32.subarray(spec.offset, spec.offset + spec.size);
        this.rnn = manifest.rnn_layers.map(l => ({ ...l, kernel: take(l.kernel), recurrent: take(l.recurrent), bias: take(l.bias) }));
        const d = (spec) => ({ ...spec, W: take(spec.W), b: take(spec.b) });
        this.phaseHead = d(manifest.heads.phase);
        this.shared = d(manifest.heads.shared);
        this.exHead = d(manifest.heads.exercise);
        this.qHead = d(manifest.heads.quality);
    }

    static async load(baseUrl = './models/web/meditask_model') {
        const res = await fetch(`${baseUrl}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`model manifest not found (${res.status})`);
        const manifest = await res.json();
        const bin = await fetch(`${baseUrl}.bin`, { cache: 'no-cache' });
        if (!bin.ok) throw new Error('model weights not found');
        return new MovementClassifier(manifest, await bin.arrayBuffer());
    }

    /** Model class for an app exercise id, or null when the model was not trained on it. */
    modelClassFor(appExerciseId) {
        const map = this.m.app_exercise_to_model_class;
        if (map && appExerciseId in map) return map[appExerciseId];
        return this.m.exercises.includes(appExerciseId) ? appExerciseId : null;
    }

    supports(appExerciseId) { return !!this.modelClassFor(appExerciseId); }

    /** True when the model's quality verdict for this exercise was reliable on held-out patients. */
    qualityReliable(appExerciseId, minAccuracy = 0.65) {
        const cls = this.modelClassFor(appExerciseId);
        const acc = this.m.quality_by_exercise?.[cls];
        return !!cls && (acc === undefined || acc >= minAccuracy);
    }

    get info() {
        const { model_name, arch, exercises, quality_labels, trained_on, metrics } = this.m;
        return { model_name, arch, exercises, quality_labels, trained_on, metrics };
    }

    /** @param {number[][]} features T x NUM_FEATURES from feature-extractor.js */
    predict(features) {
        const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
        const { feature_index: idx, mean, std } = this.m;
        let seq = features.map(row => Float32Array.from(idx, (k, i) => (row[k] - mean[i]) / (std[i] || 1)));
        for (const L of this.rnn) seq = L.type === 'lstm' ? lstmSequence(seq, L) : gruSequence(seq, L);
        const u = this.rnn[this.rnn.length - 1].units;

        const phases = seq.map(h => softmax(dense(h, this.phaseHead.W, this.phaseHead.b, u, this.phaseHead.out)));
        const gap = new Float32Array(u), gmp = new Float32Array(u).fill(-Infinity);
        for (const h of seq) for (let k = 0; k < u; k++) { gap[k] += h[k] / seq.length; if (h[k] > gmp[k]) gmp[k] = h[k]; }
        const pooled = new Float32Array(2 * u); pooled.set(gap, 0); pooled.set(gmp, u);
        const z = dense(pooled, this.shared.W, this.shared.b, 2 * u, this.shared.out, 'relu');
        const ex = softmax(dense(z, this.exHead.W, this.exHead.b, this.shared.out, this.exHead.out));
        const q = softmax(dense(z, this.qHead.W, this.qHead.b, this.shared.out, this.qHead.out));

        const argmax = a => a.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
        const ei = argmax(ex), qi = argmax(q);
        return {
            exercise: { id: this.m.exercises[ei], prob: ex[ei], probs: ex },
            quality: { label: this.m.quality_labels[qi], prob: q[qi], probs: q },
            phases: phases.map(p => this.m.phase_labels[argmax(p)]),
            latencyMs: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
    }
}

/** Load if available; resolves to null (rule-based mode) on any failure. */
export async function tryLoadClassifier(baseUrl) {
    try { return await MovementClassifier.load(baseUrl); }
    catch (e) { console.info('[MediTask] ML model not loaded - rule-based mode:', e.message); return null; }
}
