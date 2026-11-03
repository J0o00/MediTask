"""Dynamic Time Warping - Python mirror of js/intelligence/dtw-analyzer.js."""
from __future__ import annotations

import math

import numpy as np


def dtw_distance(a, b, band: float = 0.25) -> float:
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return math.inf
    vec = a.ndim > 1
    w = max(int(math.ceil(band * max(n, m))), abs(n - m))
    INF = math.inf
    prev = np.full(m + 1, INF)
    prevL = np.zeros(m + 1)
    prev[0] = 0.0
    for i in range(1, n + 1):
        cur = np.full(m + 1, INF)
        curL = np.zeros(m + 1)
        for j in range(max(1, i - w), min(m, i + w) + 1):
            c = float(np.sqrt(np.sum((a[i - 1] - b[j - 1]) ** 2))) if vec else abs(a[i - 1] - b[j - 1])
            best, L = prev[j - 1], prevL[j - 1]
            if prev[j] < best:
                best, L = prev[j], prevL[j]
            if cur[j - 1] < best:
                best, L = cur[j - 1], curL[j - 1]
            cur[j] = c + best
            curL[j] = L + 1
        prev, prevL = cur, curL
    return float(prev[m] / max(1.0, prevL[m]))


def similarity(distance: float, scale: float = 0.25) -> float:
    return math.exp(-distance / scale) if math.isfinite(distance) else 0.0


def ideal_template(cfg: dict, T: int = 30) -> np.ndarray:
    hold_frac = min(0.3, (cfg.get("holdMs") or 0) / max(1, (cfg["minRepMs"] + cfg["maxRepMs"]) / 2) + 0.1)
    rise = (1 - hold_frac) / 2
    out = []
    for i in range(T):
        x = i / (T - 1)
        if x < rise:
            p = 0.5 - 0.5 * math.cos(math.pi * x / rise)
        elif x < rise + hold_frac:
            p = 1.0
        else:
            p = 0.5 + 0.5 * math.cos(math.pi * (x - rise - hold_frac) / rise)
        out.append(p)
    return np.array(out)
