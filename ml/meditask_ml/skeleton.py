"""Common 12-joint skeleton - Python mirror of js/rehabilitation/skeleton.js.

Normalised frame convention (all sources):
    +x = subject's left, +y = up, +z = subject's forward, origin = mid-hip,
    unit = torso length (mid-hip -> mid-shoulder).
Adapters must deliver right-handed, y-up coordinates; normalisation then
removes position, size and yaw (orientation relative to the camera).
"""
from __future__ import annotations

import numpy as np

JOINTS = [
    "L_SHOULDER", "R_SHOULDER", "L_ELBOW", "R_ELBOW", "L_WRIST", "R_WRIST",
    "L_HIP", "R_HIP", "L_KNEE", "R_KNEE", "L_ANKLE", "R_ANKLE",
]
J = {n: i for i, n in enumerate(JOINTS)}
NUM_JOINTS = len(JOINTS)

# Source-skeleton index for each common joint.
MEDIAPIPE_INDEX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
# Kinect v2 (25 joints): 4 ShoulderLeft, 8 ShoulderRight, 5/9 Elbow, 6/10 Wrist, 12/16 Hip, 13/17 Knee, 14/18 Ankle
KINECT_V2_INDEX = [4, 8, 5, 9, 6, 10, 12, 16, 13, 17, 14, 18]


def from_mediapipe_world(landmarks_xyz: np.ndarray) -> np.ndarray:
    """(N,33,3) MediaPipe world landmarks -> (N,12,3) right-handed y-up (flip y and z)."""
    pts = np.asarray(landmarks_xyz, dtype=np.float64)[:, MEDIAPIPE_INDEX, :].copy()
    pts[..., 1] *= -1
    pts[..., 2] *= -1
    return pts


def normalize_frame(pts: np.ndarray) -> np.ndarray:
    """(12,3) -> (12,3). Identical arithmetic to normalizeFrame() in JS."""
    p = np.asarray(pts, dtype=np.float64)
    mh = (p[J["L_HIP"]] + p[J["R_HIP"]]) / 2
    ms = (p[J["L_SHOULDER"]] + p[J["R_SHOULDER"]]) / 2
    scale = float(np.sqrt(np.sum((ms - mh) ** 2)))
    if not scale > 1e-6:
        scale = 1.0
    q = (p - mh) / scale
    hx = q[J["L_HIP"], 0] - q[J["R_HIP"], 0]
    hz = q[J["L_HIP"], 2] - q[J["R_HIP"], 2]
    if np.hypot(hx, hz) > 1e-6:
        th = np.arctan2(hz, hx)
        c, s = np.cos(th), np.sin(th)
        x, z = q[:, 0].copy(), q[:, 2].copy()
        q[:, 0] = x * c + z * s
        q[:, 2] = -x * s + z * c
    return q


def normalize_sequence(pts: np.ndarray) -> np.ndarray:
    return np.stack([normalize_frame(f) for f in pts])
