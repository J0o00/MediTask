"""Model A - rule-based baseline: the app's threshold/rule engine applied offline.

Mirror of js/rehabilitation/movement-evaluator.js using the exact thresholds
exported to ml/config/exercises.json. Applicable only to exercises that have
an app configuration.
"""
from __future__ import annotations

import numpy as np

from .config import app_config
from .dtw import dtw_distance, ideal_template, similarity
from .features import PHASE_LABELS, phase_labels
from .metrics import compute_metrics

ERROR_PERSISTENCE = 0.25
FLAG_SEVERITY = {"too_fast": 1, "too_slow": 1, "short_hold": 1, "incomplete_rom": 2}


def progress_of(cfg, v):
    span = cfg["targetValue"] - cfg["restValue"]
    return 0.0 if abs(span) < 1e-9 else (v - cfg["restValue"]) / span


def rule_active(rule, m):
    a = m.get(rule["metric"])
    if a is None or a != a:
        return False
    if rule["metric"].startswith("arm_plane") and a < 0:
        return False
    if rule["op"] == "<":
        return a < rule["value"]
    if rule["op"] == ">":
        return a > rule["value"]
    if rule["op"] == "absdiff>":
        b = m.get(rule["metricB"])
        return b is not None and abs(a - b) > rule["value"]
    return False


def count_reversals(series, min_step=0.5):
    last, changes = 0, 0
    for i in range(1, len(series)):
        d = series[i] - series[i - 1]
        if abs(d) < min_step:
            continue
        s = int(np.sign(d))
        if last != 0 and s != last:
            changes += 1
        last = s
    return changes


def evaluate_sequence(exercise_id: str, qseq: np.ndarray, duration_ms: float | None = None) -> dict | None:
    """Score a (resampled) normalised repetition with the rule engine."""
    cfg = app_config()["exercises"].get(exercise_id)
    if cfg is None:
        return None
    mets = [compute_metrics(q) for q in qseq]
    prim = np.array([m[cfg["primaryMetric"]] for m in mets])
    prog = np.array([progress_of(cfg, v) for v in prim])
    peak = float(prog.max())
    reached = peak >= 1.0
    phases = [PHASE_LABELS[k] for k in phase_labels(prim)]

    errors = []
    for r in cfg["rules"]:
        idx = [i for i, ph in enumerate(phases) if not r.get("phases") or ph in r["phases"]]
        if not idx:
            continue
        frac = sum(rule_active(r, mets[i]) for i in idx) / len(idx)
        if frac >= ERROR_PERSISTENCE:
            errors.append((r["id"], frac, r["severity"]))
    if not reached:
        errors.append(("incomplete_rom", 1.0, 2))

    rom_score = min(1.0, max(0.0, peak)) * 100
    penalty = sum(min(1.0, f * 2) * s * 10 for _, f, s in errors)
    error_score = max(0.0, 100 - penalty)
    tempo = 100.0
    if duration_ms is not None:
        if duration_ms < cfg["minRepMs"]:
            tempo = 100 * duration_ms / cfg["minRepMs"]
        elif duration_ms > cfg["maxRepMs"]:
            tempo = max(0.0, 100 - 100 * (duration_ms - cfg["maxRepMs"]) / cfg["maxRepMs"])
    smooth = max(0.0, 100 - 25 * max(0, count_reversals(prim) - 1))
    sim = similarity(dtw_distance(prog, ideal_template(cfg, len(prog))))
    parts = [(rom_score, 0.35), (error_score, 0.35), (tempo, 0.1), (smooth, 0.1), (sim * 100, 0.1)]
    quality = sum(v * w for v, w in parts) / sum(w for _, w in parts)

    if not reached:
        label = "incomplete"
    elif quality >= 75 and not any(s >= 2 for _, _, s in errors):
        label = "correct"
    else:
        label = "incorrect"
    return {"label": label, "quality": quality, "errors": [e[0] for e in errors], "peak": peak}
