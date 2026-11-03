"""Biomechanical metrics - Python mirror of js/rehabilitation/angle-calculator.js."""
from __future__ import annotations

import math

import numpy as np

from .skeleton import J

RAD = 180.0 / math.pi
FEATURE_ANGLES = [
    "elbow_l", "elbow_r", "shoulder_l", "shoulder_r", "hip_l", "hip_r",
    "knee_l", "knee_r", "trunk_incl", "shoulder_tilt",
]


def _norm(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def angle3(a, b, c) -> float:
    u = (a[0] - b[0], a[1] - b[1], a[2] - b[2])
    v = (c[0] - b[0], c[1] - b[1], c[2] - b[2])
    nu, nv = _norm(u), _norm(v)
    if nu < 1e-9 or nv < 1e-9:
        return 0.0
    cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)
    cos = max(-1.0, min(1.0, cos))
    return math.acos(cos) * RAD


def _arm_plane(v, side):
    h = math.hypot(v[0], v[2])
    if h < 0.15 * _norm(v) or h < 1e-6:
        return -1.0
    return math.atan2(abs(v[2]), side * v[0]) * RAD


def _sagittal_flexion(v):
    if math.hypot(v[1], v[2]) < 1e-9:
        return 0.0
    return math.atan2(v[2], -v[1]) * RAD


def _frontal_abduction(v, side):
    if math.hypot(v[0], v[1]) < 1e-9:
        return 0.0
    return math.atan2(side * v[0], -v[1]) * RAD


def compute_metrics(q) -> dict:
    """q: normalised (12,3) frame -> dict of metrics in degrees."""
    q = [tuple(map(float, p)) for p in q]
    LS, RS, LE, RE = q[J["L_SHOULDER"]], q[J["R_SHOULDER"]], q[J["L_ELBOW"]], q[J["R_ELBOW"]]
    LW, RW, LH, RH = q[J["L_WRIST"]], q[J["R_WRIST"]], q[J["L_HIP"]], q[J["R_HIP"]]
    LK, RK, LA, RA = q[J["L_KNEE"]], q[J["R_KNEE"]], q[J["L_ANKLE"]], q[J["R_ANKLE"]]
    midS = tuple((LS[i] + RS[i]) / 2 for i in range(3))
    midH = tuple((LH[i] + RH[i]) / 2 for i in range(3))
    trunk = tuple(midS[i] - midH[i] for i in range(3))
    nt = _norm(trunk)
    trunk_incl = 0.0 if nt < 1e-9 else math.acos(max(-1.0, min(1.0, trunk[1] / nt))) * RAD
    sv = tuple(LS[i] - RS[i] for i in range(3))
    shoulder_tilt = math.atan2(abs(sv[1]), math.hypot(sv[0], sv[2])) * RAD

    m = {
        "elbow_l": angle3(LS, LE, LW), "elbow_r": angle3(RS, RE, RW),
        "shoulder_l": angle3(LH, LS, LE), "shoulder_r": angle3(RH, RS, RE),
        "hip_l": angle3(LS, LH, LK), "hip_r": angle3(RS, RH, RK),
        "knee_l": angle3(LH, LK, LA), "knee_r": angle3(RH, RK, RA),
        "trunk_incl": trunk_incl, "shoulder_tilt": shoulder_tilt,
    }
    m["shoulder_mean"] = (m["shoulder_l"] + m["shoulder_r"]) / 2
    m["knee_mean"] = (m["knee_l"] + m["knee_r"]) / 2
    m["hip_mean"] = (m["hip_l"] + m["hip_r"]) / 2
    m["elbow_mean"] = (m["elbow_l"] + m["elbow_r"]) / 2
    sub = lambda a, b: (a[0] - b[0], a[1] - b[1], a[2] - b[2])  # noqa: E731
    m["arm_plane_l"] = _arm_plane(sub(LE, LS), +1)
    m["arm_plane_r"] = _arm_plane(sub(RE, RS), -1)
    m["hip_abd_l"] = _frontal_abduction(sub(LK, LH), +1)
    m["hip_abd_r"] = _frontal_abduction(sub(RK, RH), -1)
    m["hip_flex_l"] = _sagittal_flexion(sub(LK, LH))
    m["hip_flex_r"] = _sagittal_flexion(sub(RK, RH))
    ankle_w = abs(LA[0] - RA[0])
    m["knee_width_ratio"] = abs(LK[0] - RK[0]) / max(ankle_w, 1e-6)
    m["wrist_height_l"] = LW[1] - LS[1]
    m["wrist_height_r"] = RW[1] - RS[1]
    return m


def metric_series(qseq, name: str) -> np.ndarray:
    return np.array([compute_metrics(q)[name] for q in qseq])
