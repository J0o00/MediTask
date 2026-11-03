// Verifies that the browser code computes exactly what the Python training
// pipeline computed: normalisation, metrics, 30x82 features, phase labels, DTW,
// and (if fixtures exist) the exported GRU/LSTM model's outputs.
// Regenerate fixtures: cd ml && python scripts/make_parity_fixtures.py --model models/<name>
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFrame } from '../../js/rehabilitation/skeleton.js';
import { computeMetrics } from '../../js/rehabilitation/angle-calculator.js';
import { repToFeatures, phaseLabels } from '../../js/intelligence/feature-extractor.js';
import { dtwDistance } from '../../js/intelligence/dtw-analyzer.js';
import { EXERCISES, progressOf } from '../../js/rehabilitation/exercise-configs.js';
import { MovementClassifier } from '../../js/intelligence/movement-classifier.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const haveFeatures = existsSync(join(FIX, 'features.json'));
const cases = haveFeatures ? JSON.parse(readFileSync(join(FIX, 'features.json'), 'utf8')).cases : [];

const maxAbs = (a, b) => {
    let m = 0;
    const walk = (x, y) => { if (Array.isArray(x)) x.forEach((v, i) => walk(v, y[i])); else m = Math.max(m, Math.abs(x - y)); };
    walk(a, b); return m;
};

test('feature fixtures present', { skip: !haveFeatures && 'run ml/scripts/make_parity_fixtures.py' }, () => {
    assert.ok(cases.length >= 5);
});

for (const c of cases) {
    test(`parity: ${c.exercise}/${c.quality}`, () => {
        const q = c.pts.map(normalizeFrame);
        assert.ok(maxAbs(q[0], c.expected.normalized_first) < 1e-9, 'normalisation');

        const m = computeMetrics(q[Math.floor(q.length / 2)]);
        for (const [k, v] of Object.entries(c.expected.metrics_mid)) {
            assert.ok(Math.abs(m[k] - v) < 1e-7, `metric ${k}: js ${m[k]} py ${v}`);
        }

        const frames = q.map((qq, i) => ({ q: qq, vis: c.vis[i] }));
        const X = repToFeatures(frames);
        const err = maxAbs(X, c.expected.features);
        assert.ok(err < 1e-9, `features max abs err ${err}`);

        const cfg = EXERCISES[c.exercise];
        const prim = q.map(f => computeMetrics(f)[cfg.primaryMetric]);
        assert.deepEqual(phaseLabels(prim), c.expected.phases_primary);

        const prog = prim.map(v => progressOf(cfg, v));
        const d = dtwDistance(prog, c.expected.template, 0.25);
        assert.ok(Math.abs(d - c.expected.dtw_progress_vs_template) < 1e-9, `dtw ${d} vs ${c.expected.dtw_progress_vs_template}`);
    });
}

const models = existsSync(FIX) ? readdirSync(FIX).filter(f => /^model_.*\.json$/.test(f) && !f.endsWith('.expected.json')) : [];
for (const f of models) {
    const base = f.replace(/\.json$/, '');
    test(`model parity: ${base}`, () => {
        const manifest = JSON.parse(readFileSync(join(FIX, f), 'utf8'));
        const buf = readFileSync(join(FIX, `${base}.bin`));
        const clf = new MovementClassifier(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const expected = JSON.parse(readFileSync(join(FIX, `${base}.expected.json`), 'utf8'));
        let worst = 0;
        cases.forEach((c, i) => {
            const p = clf.predict(c.expected.features);
            worst = Math.max(worst, maxAbs(p.exercise.probs, expected[i].exercise), maxAbs(p.quality.probs, expected[i].quality));
            assert.ok(p.latencyMs < 500);
        });
        assert.ok(worst < 1e-4, `JS vs Keras max abs prob error ${worst}`);
    });
}
