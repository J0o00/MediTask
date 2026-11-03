"""Build the harmonised temporal dataset and participant-wise splits.

    python -m meditask_ml.dataset --config config/datasets.json
    python -m meditask_ml.dataset --synthetic          # smoke test only

Outputs (ml/data/processed/):
    X_sequences.npy   (N, 30, 82) float32 features
    Q_sequences.npy   (N, 30, 12, 3) resampled normalised skeletons (for rule/DTW baselines)
    y_exercise.npy    (N,)    index into classes.json["exercises"]
    y_quality.npy     (N,)    index into classes.json["quality"]
    y_phase.npy       (N, 30) weak phase labels
    raw_frames.npz    per-sample original normalised frames (for train-time augmentation)
    metadata.csv      one row per sample
    classes.json, dataset_summary.json
    splits/{train,val,test}.csv   participant-wise 70/10/20
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupShuffleSplit

from .adapters import LOADERS
from .config import DATA_DIR, ML_ROOT, QUALITY_LABELS, primary_metric_for
from .features import SEQ_LEN, build_feature_sequence, phase_labels, primary_signal, resample_frames
from .metrics import compute_metrics
from .skeleton import normalize_sequence

TARGET_SAMPLES = 6000
REAL_SOURCES = {"kimore", "ui_prmd", "rehab24_6", "meditask_custom", "manifest"}


def featurize(q: np.ndarray, vis: np.ndarray, exercise: str):
    rq, rv = resample_frames(q, vis, SEQ_LEN)
    X = build_feature_sequence(rq, rv)
    pm = primary_metric_for(exercise)
    sig = np.array([compute_metrics(f)[pm] for f in rq]) if pm else None
    # Fall back to the dominant joint-angle component when the named metric barely moves
    # (e.g. a left-leg repetition of an exercise whose app metric is the right hip).
    if sig is None or np.ptp(sig) < 10:
        sig = primary_signal(X, None)
    return X, rq, phase_labels(sig)


def build(samples, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    exercises = sorted({s.exercise for s in samples})
    X, Q, ye, yq, yp, meta, raw = [], [], [], [], [], [], {}
    for i, s in enumerate(samples):
        if s.quality not in QUALITY_LABELS or s.n_frames < 5:
            continue
        q = normalize_sequence(s.pts)
        feats, rq, ph = featurize(q, s.vis, s.exercise)
        sid = f"{s.source}_{i:06d}"
        X.append(feats.astype(np.float32)); Q.append(rq.astype(np.float32)); yp.append(ph)
        ye.append(exercises.index(s.exercise)); yq.append(QUALITY_LABELS.index(s.quality))
        raw[sid] = np.concatenate([q.reshape(len(q), -1), s.vis], axis=1).astype(np.float32)
        meta.append({"sample_id": sid, "source": s.source, "subject": s.subject, "exercise": s.exercise,
                     "quality": s.quality, "n_frames": s.n_frames, "duration_ms": s.meta.get("duration_ms"),
                     "file": s.meta.get("file"), "variant": s.meta.get("variant")})
    np.save(out_dir / "X_sequences.npy", np.stack(X))
    np.save(out_dir / "Q_sequences.npy", np.stack(Q))
    np.save(out_dir / "y_exercise.npy", np.array(ye, np.int64))
    np.save(out_dir / "y_quality.npy", np.array(yq, np.int64))
    np.save(out_dir / "y_phase.npy", np.stack(yp).astype(np.int64))
    np.savez_compressed(out_dir / "raw_frames.npz", **raw)
    md = pd.DataFrame(meta)
    md.to_csv(out_dir / "metadata.csv", index=False)
    (out_dir / "classes.json").write_text(json.dumps({"exercises": exercises, "quality": QUALITY_LABELS}, indent=2))

    real = md[md.source.isin(REAL_SOURCES)]
    summary = {
        "total_sequences": len(md),
        "real_independent_sequences": len(real),
        "target": TARGET_SAMPLES,
        "remaining_to_target": max(0, TARGET_SAMPLES - len(real)),
        "subjects": int(md.subject.nunique()),
        "by_source": md.source.value_counts().to_dict(),
        "by_exercise_quality": {f"{k[0]}/{k[1]}": int(v) for k, v in md.groupby(["exercise", "quality"]).size().items()},
        "note": "Augmented copies are generated at training time and never counted here. Synthetic data is for smoke tests only.",
    }
    (out_dir / "dataset_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return md


def participant_split(md: pd.DataFrame, out_dir: Path, test=0.2, val=0.1, tries=200, seed=0):
    """Split by participant (no subject appears in two splits). Among many random
    group splits, keep the one whose label distribution best matches the whole set
    and which has every exercise class in training."""
    strata = md.exercise + "/" + md.quality
    overall = strata.value_counts(normalize=True)
    best, best_score = None, np.inf
    rng = np.random.default_rng(seed)
    for _ in range(tries):
        rs = int(rng.integers(1e9))
        g1 = GroupShuffleSplit(n_splits=1, test_size=test, random_state=rs)
        trv, te = next(g1.split(md, groups=md.subject))
        g2 = GroupShuffleSplit(n_splits=1, test_size=val / (1 - test), random_state=rs + 1)
        tr_i, va_i = next(g2.split(md.iloc[trv], groups=md.subject.iloc[trv]))
        tr, va = trv[tr_i], trv[va_i]
        if set(md.exercise.iloc[tr]) != set(md.exercise):
            continue
        score = 0.0
        for idx, frac in ((tr, 1 - test - val), (va, val), (te, test)):
            dist = strata.iloc[idx].value_counts(normalize=True).reindex(overall.index, fill_value=0)
            score += float(np.abs(dist - overall).sum()) + 2 * abs(len(idx) / len(md) - frac)
        if score < best_score:
            best, best_score = (tr, va, te), score
    if best is None:
        raise RuntimeError("Could not find a participant split with all exercises in training - need more subjects.")
    sp = out_dir / "splits"
    sp.mkdir(exist_ok=True)
    for name, idx in zip(("train", "val", "test"), best):
        md.iloc[idx][["sample_id", "subject", "exercise", "quality"]].to_csv(sp / f"{name}.csv", index=False)
    tr, va, te = best
    assert not (set(md.subject.iloc[tr]) & set(md.subject.iloc[te])), "subject leakage"
    print(f"split: train {len(tr)} / val {len(va)} / test {len(te)} sequences; "
          f"subjects {md.subject.iloc[tr].nunique()}/{md.subject.iloc[va].nunique()}/{md.subject.iloc[te].nunique()}")
    return best


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ML_ROOT / "config" / "datasets.json"))
    ap.add_argument("--out", default=str(DATA_DIR / "processed"))
    ap.add_argument("--synthetic", action="store_true", help="use SYNTHETIC data only (pipeline smoke test)")
    a = ap.parse_args(argv)

    samples = []
    if a.synthetic:
        samples = LOADERS["synthetic"]()
    else:
        cfg = json.loads(Path(a.config).read_text())
        for src in cfg["sources"]:
            if not src.get("enabled", True):
                continue
            root = (ML_ROOT / src["root"]) if not Path(src["root"]).is_absolute() else Path(src["root"])
            if not root.exists():
                print(f"[{src['name']}] {root} not found - skipping")
                continue
            got = LOADERS[src["loader"]](root, **src.get("options", {}))
            print(f"[{src['name']}] {len(got)} sequences, {len({s.subject for s in got})} subjects, "
                  f"{dict(Counter(s.quality for s in got))}")
            samples += got
    if not samples:
        raise SystemExit("No samples found. Download the datasets into ml/data/raw/ (see ml/README.md) or use --synthetic.")
    out = Path(a.out)
    md = build(samples, out)
    participant_split(md, out)


if __name__ == "__main__":
    main()
