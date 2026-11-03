"""Repetition segmentation - Python mirror of js/rehabilitation/repetition-counter.js.

Used to cut continuous recordings (e.g. KIMORE, raw MediTask videos) into
repetitions exactly the way the live app does, so training samples and live
inference samples are produced by the same procedure.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

DEFAULT_THRESHOLDS = dict(enter=0.20, target=1.00, holdExit=0.85, rest=0.20, partial=0.50, abortMs=1500)
PREROLL_MS = 400


@dataclass
class Rep:
    start: int
    end: int
    kind: str          # 'complete' | 'incomplete'
    peak: float
    flags: list = field(default_factory=list)


def segment(progress: np.ndarray, t_ms: np.ndarray, valid: np.ndarray | None = None,
            cfg: dict | None = None, th: dict | None = None) -> list[Rep]:
    th = {**DEFAULT_THRESHOLDS, **(th or {})}
    cfg = cfg or {"minRepMs": 0, "maxRepMs": 1e12, "holdMs": 0}
    valid = np.ones(len(progress), bool) if valid is None else valid
    state, rep, lost_since = "rest", None, None
    reps: list[Rep] = []
    preroll_start = 0

    for i, (p, t, ok) in enumerate(zip(progress, t_ms, valid)):
        if not ok:
            if state != "rest":
                lost_since = t if lost_since is None else lost_since
                if t - lost_since > th["abortMs"]:
                    state, rep, lost_since = "rest", None, None
            continue
        lost_since = None
        if rep is not None:
            rep["peak"] = max(rep["peak"], p)
            if state == "hold":
                rep["hold"] += max(0, t - rep["lastT"])
            rep["lastT"] = t

        if state == "rest":
            while preroll_start < i and t - t_ms[preroll_start] > PREROLL_MS:
                preroll_start += 1
            if p > th["enter"]:
                state = "outward"
                rep = dict(start=preroll_start, startT=t, lastT=t, peak=p, reached=False, hold=0.0)
        elif state == "outward":
            if p >= th["target"]:
                state = "hold"
                rep["reached"] = True
            elif p < th["rest"]:
                if rep["peak"] >= th["partial"]:
                    reps.append(Rep(rep["start"], i, "incomplete", rep["peak"], ["incomplete_rom"]))
                state, rep = "rest", None
                preroll_start = i
        elif state == "hold":
            if p < th["holdExit"]:
                state = "return"
        elif state == "return":
            if p >= th["target"]:
                state = "hold"
            elif p < th["rest"]:
                dur = t - rep["startT"]
                flags = []
                if dur < cfg.get("minRepMs", 0):
                    flags.append("too_fast")
                if dur > cfg.get("maxRepMs", 1e12):
                    flags.append("too_slow")
                if rep["hold"] + 1 < cfg.get("holdMs", 0):
                    flags.append("short_hold")
                reps.append(Rep(rep["start"], i, "complete", rep["peak"], flags))
                state, rep = "rest", None
                preroll_start = i
    return reps


def adaptive_progress(signal: np.ndarray) -> np.ndarray:
    """Progress for recordings without an app config: rest = median of the first
    10% of frames, target = 80% of the way to the dominant extreme."""
    s = np.asarray(signal, float)
    n0 = max(3, len(s) // 10)
    rest = float(np.median(s[:n0]))
    hi, lo = np.percentile(s, 95), np.percentile(s, 5)
    extreme = hi if (hi - rest) >= (rest - lo) else lo
    target = rest + 0.8 * (extreme - rest)
    if abs(target - rest) < 1e-6:
        return np.zeros_like(s)
    return (s - rest) / (target - rest)
