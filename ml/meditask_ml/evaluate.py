"""Evaluation utilities and the non-neural baselines.

Metrics follow the evaluation plan: accuracy, precision, recall, macro-F1,
per-class recall and confusion matrices (macro-F1 is the headline metric
because the classes are imbalanced), plus inference latency and model size.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score, confusion_matrix, precision_recall_fscore_support

from .config import QUALITY_LABELS
from .dtw import dtw_distance
from .rules import evaluate_sequence


def classification_metrics(y_true, y_pred, labels: list[str]) -> dict:
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    idx = list(range(len(labels)))
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=idx, zero_division=0)
    present = s > 0
    return {
        "n": int(len(y_true)),
        "accuracy": float(accuracy_score(y_true, y_pred)) if len(y_true) else None,
        "macro_precision": float(p[present].mean()) if present.any() else None,
        "macro_recall": float(r[present].mean()) if present.any() else None,
        "macro_f1": float(f[present].mean()) if present.any() else None,
        "per_class": {labels[i]: {"precision": float(p[i]), "recall": float(r[i]), "f1": float(f[i]), "support": int(s[i])} for i in idx},
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=idx).tolist(),
        "labels": labels,
    }


def plot_confusion(cm, labels, title, path: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cm = np.asarray(cm, float)
    norm = cm / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    fig, ax = plt.subplots(figsize=(1.1 + 0.6 * len(labels), 0.9 + 0.55 * len(labels)))
    ax.imshow(norm, cmap="Blues", vmin=0, vmax=1)
    ax.set_xticks(range(len(labels)), labels, rotation=45, ha="right", fontsize=8)
    ax.set_yticks(range(len(labels)), labels, fontsize=8)
    for i in range(len(labels)):
        for j in range(len(labels)):
            ax.text(j, i, int(cm[i, j]), ha="center", va="center", fontsize=7, color="white" if norm[i, j] > 0.5 else "black")
    ax.set_xlabel("predicted"); ax.set_ylabel("true"); ax.set_title(title, fontsize=9)
    fig.tight_layout(); fig.savefig(path, dpi=140); plt.close(fig)


# ----------------------------------------------------------------- Model A: rule-based baseline
def rule_baseline(Q, y_exercise, y_quality, exercises, durations=None) -> dict:
    """Quality classification with the app's rule engine, given the true exercise.
    Only exercises with an app configuration can be scored."""
    yt, yp, skipped = [], [], 0
    for i in range(len(Q)):
        ex = exercises[y_exercise[i]]
        d = None if durations is None else durations[i]
        res = evaluate_sequence(ex, Q[i], None if d is None or d != d else float(d))
        if res is None:
            skipped += 1
            continue
        yt.append(y_quality[i]); yp.append(QUALITY_LABELS.index(res["label"]))
    out = classification_metrics(yt, yp, QUALITY_LABELS)
    out["skipped_no_app_config"] = skipped
    return out


# ----------------------------------------------------------------- DTW nearest-neighbour baseline
ANGLE_SLICE = slice(36, 46)


def dtw_knn_baseline(X_train, ye_train, yq_train, X_test, max_templates_per_class: int = 25, seed: int = 0) -> tuple[np.ndarray, np.ndarray, float]:
    """1-NN with multivariate DTW on the 10 scaled joint angles.
    Templates: up to N random training sequences per (exercise, quality) class."""
    rng = np.random.default_rng(seed)
    keys = np.stack([ye_train, yq_train], 1)
    tmpl = []
    for k in np.unique(keys, axis=0):
        idx = np.where((keys == k).all(1))[0]
        tmpl += list(rng.choice(idx, size=min(len(idx), max_templates_per_class), replace=False))
    T = [X_train[i][:, ANGLE_SLICE] for i in tmpl]
    pe, pq = [], []
    t0 = time.perf_counter()
    for x in X_test:
        a = x[:, ANGLE_SLICE]
        d = [dtw_distance(a, t, band=0.2) for t in T]
        j = tmpl[int(np.argmin(d))]
        pe.append(ye_train[j]); pq.append(yq_train[j])
    ms = 1000 * (time.perf_counter() - t0) / max(1, len(X_test))
    return np.array(pe), np.array(pq), ms


def keras_latency_ms(model, n_features, seq_len=30, runs=50) -> float:
    x = np.zeros((1, seq_len, n_features), np.float32)
    model(x, training=False)
    t0 = time.perf_counter()
    for _ in range(runs):
        model(x, training=False)
    return 1000 * (time.perf_counter() - t0) / runs


def save_json(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o)))
