"""SYNTHETIC data - for pipeline smoke tests and CI ONLY.

Generates kinematically plausible but artificial repetitions so the whole
pipeline (build -> split -> train -> evaluate -> export -> browser parity)
can be exercised without the real datasets. Results on synthetic data say
nothing about real-world performance and must never be reported as such,
nor counted toward the 6,000 real samples.
"""
from __future__ import annotations

import math

import numpy as np

from .base import Sample

D2R = math.pi / 180


def _standing(rng, s):
    """Common-skeleton frame (12,3), y up, +x subject's left, +z forward. s = body scale."""
    sw, hw = 0.18 * s * rng.uniform(0.9, 1.1), 0.10 * s
    return np.array([
        [sw, 0.5 * s, 0], [-sw, 0.5 * s, 0],
        [sw + 0.02, 0.22 * s, 0], [-sw - 0.02, 0.22 * s, 0],
        [sw + 0.03, -0.03 * s, 0], [-sw - 0.03, -0.03 * s, 0],
        [hw, 0, 0], [-hw, 0, 0],
        [hw + 0.01, -0.45 * s, 0], [-hw - 0.01, -0.45 * s, 0],
        [hw + 0.02, -0.88 * s, 0], [-hw - 0.02, -0.88 * s, 0],
    ], dtype=float)


def _arm(P, side, elev, plane=0.0, elbow_flex=0.0, s=1.0):
    si, ei, wi = (0, 2, 4) if side == "L" else (1, 3, 5)
    out = 1 if side == "L" else -1
    th, pl = elev * D2R, plane * D2R
    d = np.array([out * math.sin(th) * math.cos(pl), -math.cos(th), math.sin(th) * math.sin(pl)])
    P[ei] = P[si] + 0.28 * s * d
    f = elbow_flex * D2R
    fd = np.array([d[0] * math.cos(f), d[1] * math.cos(f), d[2] * math.cos(f) + math.sin(f)])
    P[wi] = P[ei] + 0.25 * s * fd / np.linalg.norm(fd)


def _squat(P, knee, valgus=0.0, lean=0.0, s=1.0):
    bend = (180 - knee) / 2 * D2R
    th, sh = 0.45 * s, 0.43 * s
    for (h, k, a, sx) in [(6, 8, 10, 1), (7, 9, 11, -1)]:
        ank = np.array([sx * 0.12, -0.88 * s, 0])
        kn = np.array([sx * (0.11 - valgus), ank[1] + sh * math.cos(bend), sh * math.sin(bend)])
        hp = np.array([sx * 0.10, kn[1] + th * math.cos(bend), 0])
        P[a], P[k], P[h] = ank, kn, hp
    hy = P[6][1]
    L = lean * D2R
    for i, x in [(0, 0.18), (1, -0.18)]:
        P[i] = [x, hy + 0.5 * s * math.cos(L), 0.5 * s * math.sin(L)]
    for i, base in [(2, 0), (3, 1), (4, 0), (5, 1)]:
        drop = 0.28 if i < 4 else 0.53
        P[i] = P[base] + np.array([0.02 * (1 if base == 0 else -1), -drop * s, 0])


def _leg(P, abd, knee_bend=0.0, forward=0.0, s=1.0):
    a = abd * D2R
    fw = forward * D2R
    d = np.array([-math.sin(a), -math.cos(a) * math.cos(fw), math.cos(a) * math.sin(fw)])
    P[9] = P[7] + 0.45 * s * d
    P[11] = P[9] + 0.43 * s * d


def _profile(n, hold, rng):
    rise = (1 - hold) / 2
    x = np.linspace(0, 1, n)
    p = np.where(x < rise, 0.5 - 0.5 * np.cos(np.pi * x / rise),
                 np.where(x < rise + hold, 1.0, 0.5 + 0.5 * np.cos(np.pi * (x - rise - hold) / rise)))
    return np.clip(p + rng.normal(0, 0.01, n), 0, 1.05)


def make_rep(exercise, quality, rng, s=1.0, yaw=0.0):
    n = int(rng.integers(45, 120))
    prof = _profile(n, rng.uniform(0.05, 0.3), rng)
    amp = 1.0 if quality != "incomplete" else rng.uniform(0.55, 0.85)
    err = quality == "incorrect"
    frames = []
    for p in prof * amp:
        P = _standing(rng, s)
        if exercise == "right_hand_raise":
            _arm(P, "R", 20 + 135 * p, plane=90, elbow_flex=(45 * p if err and rng.random() < .5 else 5), s=s)
            if err:
                P[[0, 2, 4]] += np.array([0, 0.15 * p, 0])   # side lean (shoulder tilt)
        elif exercise == "shoulder_abduction":
            pl = 60 if err else 5
            _arm(P, "L", 18 + 72 * p, plane=pl, s=s)
            _arm(P, "R", 18 + (72 * p if not err else 50 * p), plane=pl, s=s)
        elif exercise == "squat":
            _squat(P, 172 - 75 * p, valgus=(0.08 * p if err else 0.0), lean=(50 * p if err else 15 * p), s=s)
        elif exercise == "elbow_flexion":
            _arm(P, "R", (50 * p if err else 8), plane=90, elbow_flex=10 + 125 * p, s=s)
        elif exercise == "lateral_leg_raise":
            _leg(P, 30 * p, forward=(35 * p if err else 0), s=s)
        frames.append(P)
    pts = np.stack(frames) + rng.normal(0, 0.006, (n, 12, 3))
    c, si = math.cos(yaw), math.sin(yaw)
    R = np.array([[c, 0, si], [0, 1, 0], [-si, 0, c]])
    pts = pts @ R.T
    vis = np.clip(rng.normal(0.95, 0.03, (n, 12)), 0.6, 1.0)
    return pts, vis, n


def load(root=None, n_subjects: int = 12, reps_per_class: int = 6, seed: int = 0, **_) -> list[Sample]:
    rng = np.random.default_rng(seed)
    out = []
    exercises = ["right_hand_raise", "shoulder_abduction", "squat", "elbow_flexion", "lateral_leg_raise"]
    for sj in range(n_subjects):
        s = rng.uniform(0.85, 1.15)
        yaw = rng.uniform(-0.4, 0.4)
        for ex in exercises:
            for q in ["correct", "incorrect", "incomplete"]:
                for _ in range(reps_per_class if q != "incomplete" else max(1, reps_per_class // 2)):
                    pts, vis, n = make_rep(ex, q, rng, s, yaw)
                    out.append(Sample("synthetic", f"synthetic:S{sj:02d}", ex, q, pts, vis, None,
                                      {"fps": 30, "duration_ms": n * 1000 / 30, "pre_segmented": True}))
    return out
