"""Export a trained Keras model for in-browser inference.

    python -m meditask_ml.export_web --model ml/models/gru_hybrid

Writes models/web/meditask_model.json (manifest) + meditask_model.bin
(float32 little-endian), consumed by js/intelligence/movement-classifier.js.
Also contains a NumPy reference forward pass used to verify the export
against Keras (and, via tests/parity, against the JavaScript implementation).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .config import WEB_MODEL_DIR


class _Packer:
    def __init__(self):
        self.parts, self.offset = [], 0

    def add(self, arr) -> dict:
        a = np.asarray(arr, dtype="<f4").reshape(-1)
        spec = {"offset": self.offset, "size": int(a.size)}
        self.parts.append(a); self.offset += a.size
        return spec

    def blob(self) -> bytes:
        return np.concatenate(self.parts).astype("<f4").tobytes()


def export(model_dir: Path, out_dir: Path = WEB_MODEL_DIR, basename: str = "meditask_model", metrics: dict | None = None) -> Path:
    import keras
    model_dir = Path(model_dir)
    model = keras.models.load_model(model_dir / "model.keras")
    pre = json.loads((model_dir / "preprocessing.json").read_text())
    metrics = metrics or (json.loads((model_dir / "metrics.json").read_text()) if (model_dir / "metrics.json").exists() else {})
    pk = _Packer()

    rnn = []
    for name in sorted([l.name for l in model.layers if l.name.startswith("rnn_")]):
        layer = model.get_layer(name)
        k, r, b = layer.get_weights()
        typ = "lstm" if layer.__class__.__name__ == "LSTM" else "gru"
        if typ == "gru":
            assert getattr(layer, "reset_after", True), "only reset_after=True GRUs are supported"
            assert b.shape == (2, k.shape[1]), b.shape
        rnn.append({"name": name, "type": typ, "units": int(layer.units), "inputDim": int(k.shape[0]),
                    "kernel": pk.add(k), "recurrent": pk.add(r), "bias": pk.add(b)})

    def dense(layer_name, inner=False):
        layer = model.get_layer(layer_name)
        if inner:
            layer = layer.layer          # TimeDistributed(Dense)
        W, b = layer.get_weights()
        return {"W": pk.add(W), "b": pk.add(b), "in": int(W.shape[0]), "out": int(W.shape[1])}

    heads = {"phase": dense("phase", inner=True), "shared": dense("shared"), "exercise": dense("exercise"), "quality": dense("quality")}
    test = metrics.get("test", {})
    manifest = {
        "format": "meditask-rnn-v1",
        "model_name": model_dir.name,
        "arch": rnn[0]["type"],
        "feature_set": pre["feature_set"],
        "feature_index": pre["feature_index"],
        "mean": [float(x) for x in pre["mean"]],
        "std": [float(x) for x in pre["std"]],
        "seq_len": int(model.input_shape[1]),
        "exercises": pre["exercises"],
        "quality_labels": pre["quality_labels"],
        "phase_labels": pre["phase_labels"],
        "rnn_layers": rnn,
        "heads": heads,
        "trained_on": pre.get("sources", []),
        "metrics": {"test_quality_macro_f1": test.get("quality", {}).get("macro_f1"),
                    "test_exercise_macro_f1": test.get("exercise", {}).get("macro_f1")},
        "weights_bytes": pk.offset * 4,
    }
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{basename}.json").write_text(json.dumps(manifest))
    (out_dir / f"{basename}.bin").write_bytes(pk.blob())
    print(f"exported {model_dir.name} -> {out_dir}/{basename}.(json|bin)  [{pk.offset * 4 / 1024:.0f} KiB]")
    return out_dir / f"{basename}.json"


# ------------------------------------------------------------- NumPy reference forward
def _sig(x):
    return 1 / (1 + np.exp(-x))


def _softmax(v):
    e = np.exp(v - v.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)


def numpy_forward(manifest: dict, blob: np.ndarray, features: np.ndarray) -> dict:
    """features: (T, 82) un-normalised -> {'exercise','quality','phase'} probabilities."""
    take = lambda s: blob[s["offset"]: s["offset"] + s["size"]]  # noqa: E731
    x = (features[:, manifest["feature_index"]] - np.array(manifest["mean"])) / np.where(np.array(manifest["std"]) == 0, 1, manifest["std"])
    seq = x
    for L in manifest["rnn_layers"]:
        u, d = L["units"], L["inputDim"]
        if L["type"] == "gru":
            K = take(L["kernel"]).reshape(d, 3 * u); R = take(L["recurrent"]).reshape(u, 3 * u); B = take(L["bias"]).reshape(2, 3 * u)
            h = np.zeros(u); out = []
            for xt in seq:
                xz = xt @ K + B[0]; hz = h @ R + B[1]
                z = _sig(xz[:u] + hz[:u]); r = _sig(xz[u:2 * u] + hz[u:2 * u])
                c = np.tanh(xz[2 * u:] + r * hz[2 * u:])
                h = z * h + (1 - z) * c; out.append(h)
        else:
            K = take(L["kernel"]).reshape(d, 4 * u); R = take(L["recurrent"]).reshape(u, 4 * u); B = take(L["bias"])
            h = np.zeros(u); c = np.zeros(u); out = []
            for xt in seq:
                g = xt @ K + h @ R + B
                i, f, cc, o = _sig(g[:u]), _sig(g[u:2 * u]), np.tanh(g[2 * u:3 * u]), _sig(g[3 * u:])
                c = f * c + i * cc; h = o * np.tanh(c); out.append(h)
        seq = np.stack(out)
    H = manifest["heads"]
    dn = lambda v, s: v @ take(s["W"]).reshape(s["in"], s["out"]) + take(s["b"])  # noqa: E731
    phase = _softmax(dn(seq, H["phase"]))
    pooled = np.concatenate([seq.mean(0), seq.max(0)])
    z = np.maximum(0, dn(pooled, H["shared"]))
    return {"exercise": _softmax(dn(z, H["exercise"])), "quality": _softmax(dn(z, H["quality"])), "phase": phase}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="directory with model.keras + preprocessing.json")
    ap.add_argument("--out", default=str(WEB_MODEL_DIR))
    a = ap.parse_args(argv)
    export(Path(a.model), Path(a.out))


if __name__ == "__main__":
    main()
