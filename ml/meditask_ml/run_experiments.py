"""Run the full model comparison and write the results chapter tables.

    python -m meditask_ml.run_experiments            # real processed dataset
    python -m meditask_ml.run_experiments --quick    # few epochs (smoke test)

Models
    A  Rule-based baseline       app thresholds + biomechanical rules (quality only)
    A2 DTW 1-nearest-neighbour    multivariate DTW on joint angles
    B  LSTM, coordinates only
    C  GRU,  coordinates only
    D  GRU,  hybrid (coordinates + biomechanical features)   <- proposed
    E  LSTM, hybrid
The model with the best VALIDATION quality macro-F1 is exported to models/web/.
Test-set numbers are reported for all models but never used for selection.
"""
from __future__ import annotations

import argparse
import json
import platform
from datetime import datetime
from pathlib import Path

import numpy as np

from .config import DATA_DIR, MODELS_DIR, QUALITY_LABELS, REPORTS_DIR
from .evaluate import classification_metrics, dtw_knn_baseline, rule_baseline, save_json
from .export_web import export
from .train import load_processed, run

NEURAL = [
    ("B", "lstm", "coords"), ("C", "gru", "coords"), ("D", "gru", "hybrid"), ("E", "lstm", "hybrid"),
]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DATA_DIR / "processed"))
    ap.add_argument("--quick", action="store_true", help="3 epochs, no augmentation (pipeline check)")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--augment", type=int, default=2)
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--tag", default="")
    a = ap.parse_args(argv)
    data = Path(a.data)
    epochs, augment = (3, 0) if a.quick else (a.epochs, a.augment)
    md, A, classes, idx = load_processed(data)
    summary = json.loads((data / "dataset_summary.json").read_text())
    tr, va, te = idx["train"], idx["val"], idx["test"]
    rows, results = [], {}

    # ---- A: rule-based
    dur = md.duration_ms.to_numpy(dtype=float)
    ra = rule_baseline(A["Q_sequences"][te], A["y_exercise"][te], A["y_quality"][te], classes["exercises"], dur[te])
    results["A_rules"] = {"test": {"quality": ra}}
    rows.append(("A", "Rule-based (app thresholds)", "-", None, ra["accuracy"], ra["macro_f1"], None))

    # ---- A2: DTW 1-NN
    X = A["X_sequences"]
    pe, pq, ms = dtw_knn_baseline(X[tr], A["y_exercise"][tr], A["y_quality"][tr], X[te])
    de = classification_metrics(A["y_exercise"][te], pe, classes["exercises"])
    dq = classification_metrics(A["y_quality"][te], pq, QUALITY_LABELS)
    results["A2_dtw_1nn"] = {"test": {"exercise": de, "quality": dq}, "latency_ms_per_sequence": ms}
    rows.append(("A2", "DTW 1-NN (joint angles)", "-", de["macro_f1"], dq["accuracy"], dq["macro_f1"], ms))

    # ---- B-E neural
    best = None
    for code, arch, feats in NEURAL:
        name = f"{arch}_{feats}{a.tag}"
        r = run(arch, feats, name, data, epochs=epochs, augment=augment, verbose=0)
        results[f"{code}_{name}"] = r
        rows.append((code, f"{arch.upper()} {feats}", f"{r['params']:,}", r["test"]["exercise"]["macro_f1"],
                     r["test"]["quality"]["accuracy"], r["test"]["quality"]["macro_f1"], r["latency_ms_reference_forward"]))
        vf1 = r["val"]["quality"]["macro_f1"] or 0
        if best is None or vf1 > best[1]:
            best = (name, vf1, r)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    synthetic = set(summary["by_source"]) == {"synthetic"}
    fmt = lambda v: "-" if v is None else f"{v:.3f}"  # noqa: E731
    lines = [
        f"# MediTask model comparison ({stamp})", "",
        "> **SYNTHETIC SMOKE-TEST DATA - these numbers demonstrate that the pipeline runs and mean nothing about real performance.**" if synthetic else "",
        f"Dataset: {summary['total_sequences']} sequences ({summary['real_independent_sequences']} real), {summary['subjects']} subjects, sources {summary['by_source']}.",
        f"Participant-wise split: train {len(tr)} / val {len(va)} / test {len(te)} sequences. Model selection on validation quality macro-F1.", "",
        "| Model | Method | Params | Exercise macro-F1 | Quality accuracy | Quality macro-F1 | Latency (ms/rep) |",
        "|---|---|---|---|---|---|---|",
    ]
    for code, method, params, ef1, qacc, qf1, lat in rows:
        lines.append(f"| {code} | {method} | {params} | {fmt(ef1)} | {fmt(qacc)} | {fmt(qf1)} | {'-' if lat is None else f'{lat:.2f}'} |")
    lines += ["", f"Selected for deployment: **{best[0]}** (validation quality macro-F1 {best[1]:.3f}).",
              "", "Per-class recall (quality, test):", ""]
    for key, r in results.items():
        q = r["test"]["quality"]["per_class"]
        lines.append(f"- {key}: " + ", ".join(f"{k} {v['recall']:.2f} (n={v['support']})" for k, v in q.items()))
    lines += ["", f"Environment: Python {platform.python_version()}, {platform.platform()}",
              "Latency: neural models = reference forward pass (NumPy, same algorithm as the browser code) per repetition; DTW = pure-Python per test sequence. In-browser latency is logged per session (summary.avgModelLatencyMs)."]
    (REPORTS_DIR / f"results{a.tag}.md").write_text("\n".join(l for l in lines if l is not None) + "\n")
    save_json(results, REPORTS_DIR / f"results{a.tag}.json")
    print("\n".join(lines))

    (REPORTS_DIR / f"selected_model{a.tag}.txt").write_text(best[0] + "\n")
    if not a.no_export:
        export(MODELS_DIR / best[0], metrics=best[2])


if __name__ == "__main__":
    main()
