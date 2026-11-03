"""Training-time augmentation (applied to the TRAIN split only, never counted as samples).

Augmentations act on the original normalised frames, then features are
recomputed, so augmented samples go through exactly the same feature code:
  - random end-cropping (0-8 % each side): imprecise repetition boundaries
  - smooth monotonic time warping: speed variation within a repetition
  - Gaussian coordinate jitter (0.01 torso lengths): pose-estimation noise
  - visibility jitter: confidence variation
Yaw/position/scale augmentations are omitted on purpose: normalisation already
removes them, so they would be no-ops.
"""
from __future__ import annotations

import numpy as np

from .features import SEQ_LEN, build_feature_sequence


def _warp_positions(n_src: int, T: int, rng) -> np.ndarray:
    a = rng.uniform(0, 0.08) * (n_src - 1)
    b = (n_src - 1) - rng.uniform(0, 0.08) * (n_src - 1)
    w = rng.uniform(0.6, 1.4, size=T - 1)
    cum = np.concatenate([[0.0], np.cumsum(w)])
    cum /= cum[-1]
    return a + cum * (b - a)


def augment_raw(raw: np.ndarray, rng, T: int = SEQ_LEN, jitter: float = 0.01):
    """raw: (N, 36+12) original normalised coords + visibility -> features (T, 82)."""
    q = raw[:, :36].reshape(-1, 12, 3).astype(np.float64)
    vis = raw[:, 36:].astype(np.float64)
    pos = _warp_positions(len(q), T, rng)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(q) - 1)
    w = (pos - lo)[:, None, None]
    qo = q[lo] * (1 - w) + q[hi] * w
    vo = vis[lo] * (1 - w[:, :, 0]) + vis[hi] * w[:, :, 0]
    qo = qo + rng.normal(0, jitter, qo.shape)
    vo = np.clip(vo + rng.normal(0, 0.03, vo.shape), 0, 1)
    return build_feature_sequence(qo, vo), qo
