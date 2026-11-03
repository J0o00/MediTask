"""Train one temporal model on the processed dataset.

    python -m meditask_ml.train --arch gru --features hybrid --name gru_hybrid
    python -m meditask_ml.train --arch lstm --features coords --name lstm_coords

Uses the participant-wise split from dataset.py: 70 % train, 10 % validation
(early stopping / model selection), 20 % test (touched once, at the end).
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .augment import augment_raw
from .config import DATA_DIR, MODELS_DIR, QUALITY_LABELS, primary_metric_for
from .evaluate import classification_metrics, keras_latency_ms, plot_confusion, save_json
from .features import FEATURE_SETS, PHASE_LABELS, phase_labels, primary_signal
from .metrics import compute_metrics


def load_processed(data_dir: Path):
    d = data_dir
    md = pd.read_csv(d / "metadata.csv")
    arr = {k: np.load(d / f"{k}.npy") for k in ["X_sequences", "Q_sequences", "y_exercise", "y_quality", "y_phase"]}
    classes = json.loads((d / "classes.json").read_text())
    splits = {s: pd.read_csv(d / "splits" / f"{s}.csv").sample_id.tolist() for s in ("train", "val", "test")}
    pos = {sid: i for i, sid in enumerate(md.sample_id)}
    idx = {s: np.array([pos[x] for x in ids]) for s, ids in splits.items()}
    return md, arr, classes, idx


def balanced_weights(y, n):
    counts = np.bincount(y, minlength=n).astype(float)
    w = np.where(counts > 0, len(y) / (n * np.maximum(counts, 1)), 0.0)
    return w[y]


def run(arch="gru", features="hybrid", name=None, data_dir=DATA_DIR / "processed", epochs=100, batch=32,
        lr=1e-3, patience=10, units=128, n_layers=2, dropout=0.3, augment=2, seed=42, out_root=MODELS_DIR, verbose=2):
    import keras
    from .models import build_model

    keras.utils.set_random_seed(seed)
    name = name or f"{arch}_{features}"
    out = Path(out_root) / name
    out.mkdir(parents=True, exist_ok=True)
    md, A, classes, idx = load_processed(Path(data_dir))
    X, ye, yq, yp = A["X_sequences"], A["y_exercise"], A["y_quality"], A["y_phase"]
    fidx = FEATURE_SETS[features]

    # ---- training set (+ augmentation, train split only)
    tr = idx["train"]
    Xtr, yetr, yqtr, yptr = [X[tr]], [ye[tr]], [yq[tr]], [yp[tr]]
    if augment:
        raw = np.load(Path(data_dir) / "raw_frames.npz")
        rng = np.random.default_rng(seed)
        prim_cache = {}
        for _ in range(augment):
            xa, pa = [], []
            for i in tr:
                f, qo = augment_raw(raw[md.sample_id[i]], rng)
                xa.append(f)
                ex = classes["exercises"][ye[i]]
                pm = prim_cache.setdefault(ex, primary_metric_for(ex))
                sig = np.array([compute_metrics(q)[pm] for q in qo]) if pm else None
                if sig is None or np.ptp(sig) < 10:
                    sig = primary_signal(f, None)
                pa.append(phase_labels(sig))
            Xtr.append(np.stack(xa).astype(np.float32)); yetr.append(ye[tr]); yqtr.append(yq[tr]); yptr.append(np.stack(pa))
    Xtr, yetr, yqtr, yptr = map(np.concatenate, (Xtr, yetr, yqtr, yptr))
    Xtr = Xtr[:, :, fidx]

    # ---- standardisation (fit on training data only)
    mean = Xtr.reshape(-1, Xtr.shape[-1]).mean(0)
    std = Xtr.reshape(-1, Xtr.shape[-1]).std(0)
    std = np.where(std < 1e-6, 1.0, std)
    norm = lambda Z: ((Z[:, :, fidx] - mean) / std).astype(np.float32)  # noqa: E731
    Xtr = ((Xtr - mean) / std).astype(np.float32)
    va, te = idx["val"], idx["test"]
    Xva, Xte = norm(X[va]), norm(X[te])

    n_ex = len(classes["exercises"])
    model = build_model(arch, len(fidx), n_ex, len(QUALITY_LABELS), len(PHASE_LABELS),
                        units=units, n_layers=n_layers, dropout=dropout, lr=lr)
    sw = {"exercise": balanced_weights(yetr, n_ex), "quality": balanced_weights(yqtr, len(QUALITY_LABELS)),
          "phase": np.ones((len(yptr), yptr.shape[1]), np.float32)}
    cb = [keras.callbacks.EarlyStopping(monitor="val_loss", patience=patience, restore_best_weights=True)]
    hist = model.fit(Xtr, {"exercise": yetr, "quality": yqtr, "phase": yptr}, sample_weight=sw,
                     validation_data=(Xva, {"exercise": ye[va], "quality": yq[va], "phase": yp[va]}),
                     epochs=epochs, batch_size=batch, callbacks=cb, verbose=verbose)

    # ---- evaluation
    res = {"name": name, "arch": arch, "features": features, "n_features": len(fidx),
           "params": int(model.count_params()), "epochs_run": len(hist.history["loss"]),
           "train_sequences": int(len(Xtr)), "train_original": int(len(tr)), "val": int(len(va)), "test": int(len(te))}
    for split, Z, ii in (("val", Xva, va), ("test", Xte, te)):
        pred = model.predict(Z, verbose=0)
        res[split] = {
            "exercise": classification_metrics(ye[ii], pred["exercise"].argmax(1), classes["exercises"]),
            "quality": classification_metrics(yq[ii], pred["quality"].argmax(1), QUALITY_LABELS),
            "phase": classification_metrics(yp[ii].reshape(-1), pred["phase"].argmax(-1).reshape(-1), PHASE_LABELS),
        }
        qp = pred["quality"].argmax(1)
        res[split]["quality_by_exercise"] = {
            ex: classification_metrics(yq[ii][ye[ii] == k], qp[ye[ii] == k], QUALITY_LABELS)
            for k, ex in enumerate(classes["exercises"]) if (ye[ii] == k).any()}
    for head, labels in (("exercise", classes["exercises"]), ("quality", QUALITY_LABELS)):
        plot_confusion(res["test"][head]["confusion_matrix"], labels, f"{name} - {head} (test)", out / f"cm_{head}.png")

    model.save(out / "model.keras")
    save_json({"feature_set": features, "feature_index": fidx, "mean": mean, "std": std,
               "exercises": classes["exercises"], "quality_labels": QUALITY_LABELS, "phase_labels": PHASE_LABELS,
               "sources": sorted(md.source.unique().tolist())}, out / "preprocessing.json")
    save_json({k: [float(v) for v in vals] for k, vals in hist.history.items()}, out / "history.json")
    # Latency of the exported model with the reference forward pass (same algorithm as the
    # browser implementation), plus Keras eager batch-1 for comparison.
    from .export_web import export, numpy_forward
    mpath = export(out, out / "web", metrics=res)
    man = json.loads(mpath.read_text())
    blob = np.fromfile(out / "web" / "meditask_model.bin", dtype="<f4")
    sample = X[te[0]] if len(te) else X[tr[0]]
    numpy_forward(man, blob, sample)
    t0 = time.perf_counter()
    for _ in range(20):
        numpy_forward(man, blob, sample)
    res["latency_ms_reference_forward"] = 1000 * (time.perf_counter() - t0) / 20
    res["latency_ms_keras_eager_batch1"] = keras_latency_ms(model, len(fidx), runs=10)
    res["weights_kib"] = man["weights_bytes"] / 1024
    save_json(res, out / "metrics.json")
    _plot_history(hist.history, out / "training_curves.png", name)
    print(f"[{name}] test quality macro-F1 = {res['test']['quality']['macro_f1']:.3f}, "
          f"exercise macro-F1 = {res['test']['exercise']['macro_f1']:.3f}")
    return res


def _plot_history(h, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(9, 3.2))
    ax[0].plot(h["loss"], label="train"); ax[0].plot(h["val_loss"], label="val"); ax[0].set_title("total loss"); ax[0].legend()
    for k in ("quality_accuracy", "exercise_accuracy"):
        if k in h:
            ax[1].plot(h[k], label=f"train {k.split('_')[0]}"); ax[1].plot(h[f"val_{k}"], "--", label=f"val {k.split('_')[0]}")
    ax[1].set_title("accuracy"); ax[1].legend(fontsize=7)
    fig.suptitle(title, fontsize=9); fig.tight_layout(); fig.savefig(path, dpi=130); plt.close(fig)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", choices=["gru", "lstm"], default="gru")
    ap.add_argument("--features", choices=list(FEATURE_SETS), default="hybrid")
    ap.add_argument("--name")
    ap.add_argument("--data", default=str(DATA_DIR / "processed"))
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--units", type=int, default=128)
    ap.add_argument("--layers", type=int, default=2)
    ap.add_argument("--dropout", type=float, default=0.3)
    ap.add_argument("--augment", type=int, default=2, help="augmented copies per training sequence")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args(argv)
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    run(a.arch, a.features, a.name, Path(a.data), a.epochs, a.batch, a.lr, a.patience, a.units, a.layers, a.dropout, a.augment, a.seed)


if __name__ == "__main__":
    main()
