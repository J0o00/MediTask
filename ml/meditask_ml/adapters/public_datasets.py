"""Adapters for the public rehabilitation datasets.

IMPORTANT - verify before training
----------------------------------
These loaders follow the file layouts described in the datasets' publications
as closely as could be determined without the data in hand. Each dataset
ships its own README; check the directory names, column layouts, joint order
and label definitions below against it (look for "VERIFY") and adjust the
constants. Also confirm each dataset's licence permits your use.

  KIMORE     Capecci et al., IEEE TNSRE 2019 - Kinect v2, 78 subjects, 5 exercises, clinical scores
  UI-PRMD    Vakanski et al., Data 2018      - Kinect + Vicon, 10 subjects, 10 exercises, correct/incorrect
  REHAB24-6  Cernek et al., 2024 (MUNI)      - 2D/3D skeletons, 6 exercises, correct/incorrect

All Kinect data is converted to the common 12-joint skeleton. Kinect camera
space is right-handed with y up, so no axis flip is needed; normalisation
then rotates every frame so the subject faces +z.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

from ..config import primary_metric_for, taxonomy
from ..features import primary_signal
from ..metrics import compute_metrics
from ..segmentation import adaptive_progress, segment
from ..skeleton import KINECT_V2_INDEX, normalize_sequence
from .base import Sample, remap

# VERIFY: UI-PRMD Kinect files have 22 joints x 3 = 66 columns. Joint order assumed:
# 0 waist 1 spine 2 chest 3 neck 4 head 5 head-tip 6 L-collar 7 L-upper-arm(shoulder) 8 L-forearm(elbow)
# 9 L-hand(wrist) 10 R-collar 11 R-upper-arm 12 R-forearm 13 R-hand 14 L-upper-leg(hip) 15 L-lower-leg(knee)
# 16 L-foot(ankle) 17 L-toes 18 R-upper-leg 19 R-lower-leg 20 R-foot 21 R-toes
UIPRMD_KINECT_INDEX = [7, 11, 8, 12, 9, 13, 14, 18, 15, 19, 16, 20]
# COCO-17 (2-D keypoints, e.g. from REHAB24-6 2-D files or other pose estimators)
COCO17_INDEX = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
MEDIAPIPE33_INDEX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
LAYOUTS = {"kinect25": KINECT_V2_INDEX, "uiprmd22": UIPRMD_KINECT_INDEX, "coco17": COCO17_INDEX, "mediapipe33": MEDIAPIPE33_INDEX}


def _read_numeric(path: Path) -> np.ndarray:
    df = pd.read_csv(path, header=None, sep=None, engine="python")
    df = df.apply(pd.to_numeric, errors="coerce").dropna(axis=1, how="all").dropna(axis=0, how="any")
    return df.to_numpy(dtype=np.float64)


def _segment_continuous(pts, vis, t_ms, exercise):
    """Cut a continuous recording into repetitions with the app's state machine."""
    q = normalize_sequence(pts)
    pm = primary_metric_for(exercise)
    if pm:
        sig = np.array([compute_metrics(f)[pm] for f in q])
    else:
        from ..features import rep_to_features  # local import to avoid a cycle
        feats = np.stack([rep_to_features(q[i:i + 1], vis[i:i + 1], 1)[0] for i in range(len(q))])
        sig = primary_signal(feats, None)
    prog = adaptive_progress(sig)
    return segment(prog, t_ms)


# --------------------------------------------------------------------------- KIMORE
def load_kimore(root: str | Path, fps: float = 30.0, **_) -> list[Sample]:
    root = Path(root)
    tx = taxonomy()["sources"]["kimore"]
    out = []
    # VERIFY layout: <group>/<subgroup>/<subject>/Es<k>/Raw/JointPosition*.csv and .../Label/ClinicalAssessment*
    for jp in sorted(root.rglob("JointPosition*.csv")):
        es = next((p for p in jp.parts if re.fullmatch(r"Es[1-5]", p)), None)
        if es is None:
            continue
        exercise = tx["exercise_map"][es]
        subj_dir = jp.parents[2]
        subject = f"kimore:{subj_dir.name}"
        group = "CG" if "CG" in jp.parts else "GPP"
        arr = _read_numeric(jp)
        if arr.shape[1] >= 100:
            arr = arr[:, :100].reshape(len(arr), 25, 4)       # x, y, z, tracking state
            vis = np.where(arr[:, :, 3] >= 2, 1.0, 0.5)[:, KINECT_V2_INDEX] if arr[:, :, 3].max() <= 2 else np.ones((len(arr), 12))
        elif arr.shape[1] >= 75:
            arr = arr[:, :75].reshape(len(arr), 25, 3)
            vis = np.ones((len(arr), 12))
        else:
            print(f"[kimore] skip {jp}: {arr.shape[1]} columns")
            continue
        pts = remap(arr, KINECT_V2_INDEX)
        quality = _kimore_quality(jp.parents[1] / "Label", es, group, tx)
        t = np.arange(len(pts)) * 1000.0 / fps
        for k, rep in enumerate(_segment_continuous(pts, vis, t, exercise)):
            sl = slice(rep.start, rep.end + 1)
            out.append(Sample("kimore", subject, exercise, "incomplete" if rep.kind == "incomplete" else quality,
                              pts[sl], vis[sl], t[sl] - t[rep.start],
                              {"file": str(jp.relative_to(root)), "rep": k, "group": group, "fps": fps,
                               "duration_ms": float(t[rep.end] - t[rep.start])}))
    return out


def _kimore_quality(label_dir: Path, es: str, group: str, tx: dict) -> str:
    files = list(label_dir.glob("ClinicalAssessment*")) if label_dir.exists() else []
    for f in files:
        try:
            df = pd.read_excel(f) if f.suffix.lower() in (".xlsx", ".xls") else pd.read_csv(f)
        except Exception:  # noqa: BLE001
            continue
        num = es[-1]
        cols = [c for c in df.columns if "ts" in str(c).lower() and num in str(c)]
        if cols:
            score = pd.to_numeric(df[cols[0]], errors="coerce").dropna()
            if len(score):
                return "correct" if score.iloc[0] >= tx["correct_threshold"] * tx["score_max"] else "incorrect"
    # Fallback (weaker): healthy control group performs correctly.
    return "correct" if group == "CG" else "incorrect"


# --------------------------------------------------------------------------- UI-PRMD
def load_ui_prmd(root: str | Path, fps: float = 30.0, **_) -> list[Sample]:
    root = Path(root)
    emap = taxonomy()["sources"]["ui_prmd"]["exercise_map"]
    out = []
    # VERIFY layout: "Segmented Movements/Kinect/Positions/m01_s01_e01_positions.txt" and
    # "Incorrect Segmented Movements/Kinect/Positions/m01_s01_e01_positions_inc.txt"
    for f in sorted(root.rglob("*_positions*.txt")):
        if "kinect" not in str(f).lower():
            continue
        m = re.match(r"(m\d\d)_(s\d\d)_(e\d\d)", f.name)
        if not m or m.group(1) not in emap:
            continue
        incorrect = "incorrect" in str(f).lower() or f.stem.endswith("_inc")
        arr = _read_numeric(f)
        if arr.shape[1] < 66:
            print(f"[ui_prmd] skip {f.name}: {arr.shape[1]} columns")
            continue
        arr = arr[:, :66].reshape(len(arr), 22, 3)
        pts = remap(arr, UIPRMD_KINECT_INDEX)
        out.append(Sample("ui_prmd", f"ui_prmd:{m.group(2)}", emap[m.group(1)], "incorrect" if incorrect else "correct",
                          pts, np.ones((len(pts), 12)), None,
                          {"file": f.name, "episode": m.group(3), "fps": fps, "duration_ms": len(pts) * 1000.0 / fps, "pre_segmented": True}))
    return out


# --------------------------------------------------------------------------- manifest-driven (REHAB24-6 and any other source)
def load_manifest(root: str | Path, manifest: str = "manifest.csv", source: str = "rehab24_6", **_) -> list[Sample]:
    """Generic loader driven by a CSV you prepare once per dataset.

    manifest.csv columns:
        file, subject, exercise, quality, layout, fps, y_down, segmented
    - file: path relative to root; .csv/.txt (frames x joints*D) or .npy (frames, joints, D)
    - exercise: source code (mapped via label_taxonomy.json) or a common class id
    - quality: correct | incorrect | incomplete
    - layout: kinect25 | uiprmd22 | coco17 | mediapipe33
    - y_down: 1 if image-style coordinates (y grows downward), else 0
    - segmented: 1 if the file is one repetition, 0 if continuous (auto-segmented)
    """
    root = Path(root)
    emap = taxonomy()["sources"].get(source, {}).get("exercise_map", {})
    man = pd.read_csv(root / manifest)
    out = []
    for _, r in man.iterrows():
        path = root / r["file"]
        arr = np.load(path) if path.suffix == ".npy" else _read_numeric(path)
        layout = r.get("layout", "coco17")
        n_src = {"kinect25": 25, "uiprmd22": 22, "coco17": 17, "mediapipe33": 33}[layout]
        if arr.ndim == 2:
            D = arr.shape[1] // n_src
            arr = arr[:, : n_src * D].reshape(len(arr), n_src, D)
        if arr.shape[2] == 2:                                   # 2-D keypoints: z = 0
            arr = np.concatenate([arr, np.zeros(arr.shape[:2] + (1,))], axis=2)
        pts = remap(arr, LAYOUTS[layout])
        if int(r.get("y_down", 0)):
            pts[..., 1] *= -1
            pts[..., 2] *= -1
        vis = np.ones((len(pts), 12))
        fps = float(r.get("fps", 30))
        ex = emap.get(str(r["exercise"]), str(r["exercise"]))
        subject = f"{source}:{r['subject']}"
        t = np.arange(len(pts)) * 1000.0 / fps
        if int(r.get("segmented", 1)):
            out.append(Sample(source, subject, ex, str(r["quality"]), pts, vis, t,
                              {"file": str(r["file"]), "fps": fps, "duration_ms": float(t[-1]), "pre_segmented": True}))
        else:
            for k, rep in enumerate(_segment_continuous(pts, vis, t, ex)):
                sl = slice(rep.start, rep.end + 1)
                out.append(Sample(source, subject, ex, "incomplete" if rep.kind == "incomplete" else str(r["quality"]),
                                  pts[sl], vis[sl], t[sl] - t[rep.start],
                                  {"file": str(r["file"]), "rep": k, "fps": fps, "duration_ms": float(t[rep.end] - t[rep.start])}))
    return out


def load_rehab24_6(root: str | Path, **kw) -> list[Sample]:
    """REHAB24-6: prepare manifest.csv (see load_manifest) from the dataset's annotation files."""
    return load_manifest(root, source="rehab24_6", **kw)
