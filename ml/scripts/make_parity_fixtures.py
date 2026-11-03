"""Generate fixtures that prove the browser (JS) and training (Python) code agree.

    cd ml && python scripts/make_parity_fixtures.py [--model models/gru_hybrid_smoke ...]

Writes tests/parity/fixtures/:
  features.json   raw skeleton sequences + Python-computed normalised frames,
                  metrics, 30x82 features, phase labels and DTW distances
  <name>.json/.bin + <name>.expected.json   exported model and Python/Keras outputs
The Node test tests/parity/parity.test.mjs recomputes everything in JS.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from meditask_ml.adapters.synthetic import make_rep  # noqa: E402
from meditask_ml.dtw import dtw_distance, ideal_template  # noqa: E402
from meditask_ml.config import exercise_config  # noqa: E402
from meditask_ml.features import phase_labels, rep_to_features  # noqa: E402
from meditask_ml.metrics import compute_metrics  # noqa: E402
from meditask_ml.skeleton import normalize_sequence  # noqa: E402

OUT = ROOT.parent / "tests" / "parity" / "fixtures"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", default=[])
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(123)
    cases = []
    for ex in ["right_hand_raise", "shoulder_abduction", "squat", "elbow_flexion", "lateral_leg_raise"]:
        for q in ["correct", "incorrect"]:
            pts, vis, n = make_rep(ex, q, rng, s=rng.uniform(0.9, 1.1), yaw=rng.uniform(-0.5, 0.5))
            qn = normalize_sequence(pts)
            feats = rep_to_features(qn, vis)
            cfg = exercise_config(ex)
            prim = [compute_metrics(f)[cfg["primaryMetric"]] for f in qn]
            tmpl = ideal_template(cfg, 30)
            prog = np.array([(v - cfg["restValue"]) / (cfg["targetValue"] - cfg["restValue"]) for v in prim])
            cases.append({
                "exercise": ex, "quality": q,
                "pts": np.round(pts, 6).tolist(), "vis": np.round(vis, 6).tolist(),
                "expected": {
                    "normalized_first": qn[0].tolist(),
                    "metrics_mid": compute_metrics(qn[len(qn) // 2]),
                    "features": feats.tolist(),
                    "phases_primary": phase_labels(prim).tolist(),
                    "dtw_progress_vs_template": dtw_distance(prog, tmpl),
                    "template": tmpl.tolist(),
                },
            })
    # inputs are rounded above; recompute expectations from the rounded inputs so both sides see identical data
    for c in cases:
        pts, vis = np.array(c["pts"]), np.array(c["vis"])
        qn = normalize_sequence(pts)
        cfg = exercise_config(c["exercise"])
        prim = [compute_metrics(f)[cfg["primaryMetric"]] for f in qn]
        prog = np.array([(v - cfg["restValue"]) / (cfg["targetValue"] - cfg["restValue"]) for v in prim])
        c["expected"].update({
            "normalized_first": qn[0].tolist(), "metrics_mid": compute_metrics(qn[len(qn) // 2]),
            "features": rep_to_features(qn, vis).tolist(), "phases_primary": phase_labels(prim).tolist(),
            "dtw_progress_vs_template": dtw_distance(prog, np.array(c["expected"]["template"])),
        })
    (OUT / "features.json").write_text(json.dumps({"cases": cases}))
    print(f"wrote {len(cases)} feature cases")

    for mdir in a.model:
        import keras
        from meditask_ml.export_web import export, numpy_forward
        mdir = ROOT / mdir if not Path(mdir).is_absolute() else Path(mdir)
        name = f"model_{mdir.name}"
        mpath = export(mdir, OUT, basename=name)
        man = json.loads(mpath.read_text())
        blob = np.fromfile(OUT / f"{name}.bin", dtype="<f4")
        model = keras.models.load_model(mdir / "model.keras")
        exp = []
        for c in cases:
            f = np.array(c["expected"]["features"])
            ref = numpy_forward(man, blob, f)
            x = ((f[:, man["feature_index"]] - np.array(man["mean"])) / np.array(man["std"]))[None].astype(np.float32)
            k = model.predict(x, verbose=0)
            err = max(float(np.abs(ref["quality"] - k["quality"][0]).max()), float(np.abs(ref["exercise"] - k["exercise"][0]).max()),
                      float(np.abs(ref["phase"] - k["phase"][0]).max()))
            assert err < 1e-4, f"NumPy reference disagrees with Keras by {err}"
            exp.append({"exercise": ref["exercise"].tolist(), "quality": ref["quality"].tolist(), "phase": ref["phase"].tolist()})
        (OUT / f"{name}.expected.json").write_text(json.dumps(exp))
        print(f"{name}: NumPy reference == Keras (max abs err < 1e-4)")


if __name__ == "__main__":
    main()
