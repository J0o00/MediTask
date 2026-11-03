"""Common sample representation produced by every dataset adapter."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Sample:
    source: str                 # 'kimore' | 'ui_prmd' | 'rehab24_6' | 'meditask_custom' | 'synthetic' ...
    subject: str                # participant id, globally unique: f"{source}:{id}"
    exercise: str               # common taxonomy class (ml/config/label_taxonomy.json)
    quality: str                # 'correct' | 'incorrect' | 'incomplete'
    pts: np.ndarray             # (N,12,3) right-handed, y up, any unit/origin
    vis: np.ndarray             # (N,12) confidence 0..1 (1.0 for motion capture)
    t_ms: np.ndarray | None = None
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        self.pts = np.asarray(self.pts, dtype=np.float64)
        self.vis = np.asarray(self.vis, dtype=np.float64)
        assert self.pts.ndim == 3 and self.pts.shape[1:] == (12, 3), self.pts.shape
        assert self.vis.shape == self.pts.shape[:2], (self.vis.shape, self.pts.shape)
        if self.t_ms is None:
            fps = float(self.meta.get("fps", 30))
            self.t_ms = np.arange(len(self.pts)) * 1000.0 / fps

    @property
    def n_frames(self) -> int:
        return len(self.pts)


def remap(frames: np.ndarray, index: list[int]) -> np.ndarray:
    """Pick the 12 common joints from a source skeleton array (N, J, >=3)."""
    return np.asarray(frames, dtype=np.float64)[:, index, :3]
