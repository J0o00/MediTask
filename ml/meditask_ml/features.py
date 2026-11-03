"""Temporal features - Python mirror of js/intelligence/feature-extractor.js.

One sample = one repetition, resampled to SEQ_LEN frames x NUM_FEATURES (82):
    [0:36]  normalised x,y,z of the 12 common joints
    [36:46] 10 joint angles / 180
    [46:56] angular velocity  (first difference of the scaled angles)
    [56:66] angular acceleration (second difference)
    [66:70] left-right symmetry |L-R| / 180 for elbow, shoulder, hip, knee
    [70:82] landmark visibility / confidence
"""
from __future__ import annotations

import numpy as np

from .metrics import FEATURE_ANGLES, compute_metrics
from .skeleton import NUM_JOINTS

SEQ_LEN = 30
SYMMETRY_PAIRS = [("elbow_l", "elbow_r"), ("shoulder_l", "shoulder_r"), ("hip_l", "hip_r"), ("knee_l", "knee_r")]
NUM_FEATURES = NUM_JOINTS * 3 + len(FEATURE_ANGLES) * 3 + len(SYMMETRY_PAIRS) + NUM_JOINTS
PHASE_LABELS = ["rest", "outward", "hold", "return"]

COORD_IDX = list(range(0, 36))
ANGLE_IDX = list(range(36, 46))
VIS_IDX = list(range(70, 82))
FEATURE_SETS = {
    # Models B/C: landmark coordinates + confidence only (what a plain pose model sees)
    "coords": COORD_IDX + VIS_IDX,
    # Model D: hybrid = coordinates + biomechanical features (angles, kinematics, symmetry)
    "hybrid": list(range(NUM_FEATURES)),
}


def feature_names() -> list[str]:
    names = [f"j{j}_{ax}" for j in range(NUM_JOINTS) for ax in "xyz"]
    names += list(FEATURE_ANGLES)
    names += [f"d_{a}" for a in FEATURE_ANGLES]
    names += [f"dd_{a}" for a in FEATURE_ANGLES]
    names += [f"sym_{a.split('_')[0]}" for a, _ in SYMMETRY_PAIRS]
    names += [f"vis_{j}" for j in range(NUM_JOINTS)]
    return names


def resample_frames(q: np.ndarray, vis: np.ndarray, T: int = SEQ_LEN):
    """Linear resampling by frame index. q: (N,12,3) normalised, vis: (N,12)."""
    N = len(q)
    if N == 0:
        raise ValueError("empty sequence")
    qo = np.empty((T, q.shape[1], 3))
    vo = np.empty((T, vis.shape[1]))
    for i in range(T):
        pos = 0.0 if T == 1 else i * (N - 1) / (T - 1)
        lo = int(np.floor(pos))
        hi = min(lo + 1, N - 1)
        w = pos - lo
        qo[i] = q[lo] * (1 - w) + q[hi] * w
        vo[i] = vis[lo] * (1 - w) + vis[hi] * w
    return qo, vo


def build_feature_sequence(q: np.ndarray, vis: np.ndarray) -> np.ndarray:
    """q: (T,12,3) resampled normalised frames, vis: (T,12) -> (T, 82)."""
    rows = []
    prev_a = prev_v = None
    for t in range(len(q)):
        m = compute_metrics(q[t])
        a = np.array([m[k] / 180.0 for k in FEATURE_ANGLES])
        v = a - prev_a if prev_a is not None else np.zeros_like(a)
        acc = v - prev_v if prev_v is not None else np.zeros_like(v)
        sym = np.array([abs(m[l] - m[r]) / 180.0 for l, r in SYMMETRY_PAIRS])
        rows.append(np.concatenate([q[t].reshape(-1), a, v, acc, sym, vis[t]]))
        prev_a, prev_v = a, v
    return np.stack(rows)


def rep_to_features(q: np.ndarray, vis: np.ndarray, T: int = SEQ_LEN) -> np.ndarray:
    return build_feature_sequence(*resample_frames(q, vis, T))


def phase_labels(series) -> np.ndarray:
    """Weak per-frame phase labels from a primary-metric trajectory (mirror of JS)."""
    s = np.asarray(series, dtype=np.float64)
    start = s[0]
    d = np.abs(s - start)
    amp = float(d.max()) if len(d) else 0.0
    if amp < 1e-6:
        return np.zeros(len(s), dtype=np.int64)
    k = int(np.argmax(d))  # first index of the maximum, as in JS (strict >)
    p = d / amp
    out = np.empty(len(s), dtype=np.int64)
    for t in range(len(s)):
        if p[t] >= 0.85:
            out[t] = 2
        elif p[t] < 0.15:
            out[t] = 0
        else:
            out[t] = 1 if t <= k else 3
    return out


def primary_signal(feats: np.ndarray, primary_metric: str | None, qseq: np.ndarray | None = None) -> np.ndarray:
    """Signal used for phase labels: the exercise's primary metric if known,
    otherwise the first principal component of the scaled joint angles."""
    if primary_metric and qseq is not None:
        return np.array([compute_metrics(q)[primary_metric] for q in qseq])
    A = feats[:, ANGLE_IDX]
    A = A - A.mean(axis=0, keepdims=True)
    if np.allclose(A, 0):
        return np.zeros(len(A))
    _, _, vt = np.linalg.svd(A, full_matrices=False)
    return A @ vt[0]
