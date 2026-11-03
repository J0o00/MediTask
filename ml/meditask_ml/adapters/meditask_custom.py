"""MediTask's own recordings, exported from collect.html (format meditask-sequences-v1).

Coordinates are already in the common skeleton (MediaPipe world, y up, z flipped)
and each sample is one automatically segmented repetition.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .base import Sample


def load(root: str | Path, **_) -> list[Sample]:
    out = []
    for f in sorted(Path(root).glob("*.json")):
        data = json.loads(f.read_text())
        if data.get("format") != "meditask-sequences-v1":
            print(f"[meditask_custom] skip {f.name}: unknown format")
            continue
        for k, s in enumerate(data["samples"]):
            if len(s["frames"]) < 5:
                continue
            pts = np.array([fr["pts"] for fr in s["frames"]])
            vis = np.array([fr["vis"] for fr in s["frames"]])
            t = np.array([fr["t"] for fr in s["frames"]], float)
            out.append(Sample(
                source="meditask_custom", subject=f"meditask_custom:{s['subject']}",
                exercise=s["exercise"], quality=s["label"], pts=pts, vis=vis, t_ms=t - t[0],
                meta={"file": f.name, "index": k, "variant": s.get("variant"), "setup": s.get("setup"),
                      "duration_ms": float(t[-1] - t[0]), "pre_segmented": True},
            ))
    return out
