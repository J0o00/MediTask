"""Multi-task temporal models (Keras).

            input (30 x F)
                 |
     RNN(128, seq) -> Dropout -> RNN(128, seq) -> Dropout        (GRU or LSTM)
         |                                   |
   TimeDistributed Dense(4)          GlobalAvgPool ++ GlobalMaxPool
     "phase" (per frame)                     |
                                   Dense(64, relu) -> Dropout
                                     |                 |
                          Dense(n_ex) "exercise"   Dense(3) "quality"

Layer names are fixed because export_web.py and the browser inference
(js/intelligence/movement-classifier.js) depend on them.
"""
from __future__ import annotations

import keras
from keras import layers


def build_model(arch: str, n_features: int, n_exercises: int, n_quality: int = 3, n_phase: int = 4,
                seq_len: int = 30, units: int = 128, n_layers: int = 2, dropout: float = 0.3, dense: int = 64,
                lr: float = 1e-3) -> keras.Model:
    RNN = {"gru": layers.GRU, "lstm": layers.LSTM}[arch]
    inp = keras.Input((seq_len, n_features), name="features")
    x = inp
    for i in range(n_layers):
        x = RNN(units, return_sequences=True, name=f"rnn_{i + 1}")(x)
        x = layers.Dropout(dropout, name=f"drop_{i + 1}")(x)
    phase = layers.TimeDistributed(layers.Dense(n_phase, activation="softmax"), name="phase")(x)
    pooled = layers.Concatenate(name="pool")([layers.GlobalAveragePooling1D(name="gap")(x), layers.GlobalMaxPooling1D(name="gmp")(x)])
    z = layers.Dense(dense, activation="relu", name="shared")(pooled)
    z = layers.Dropout(dropout, name="drop_shared")(z)
    ex = layers.Dense(n_exercises, activation="softmax", name="exercise")(z)
    q = layers.Dense(n_quality, activation="softmax", name="quality")(z)
    model = keras.Model(inp, {"exercise": ex, "quality": q, "phase": phase}, name=f"meditask_{arch}")
    model.compile(
        optimizer=keras.optimizers.Adam(lr),
        loss={"exercise": "sparse_categorical_crossentropy", "quality": "sparse_categorical_crossentropy",
              "phase": "sparse_categorical_crossentropy"},
        loss_weights={"exercise": 1.0, "quality": 1.0, "phase": 0.5},
        metrics={"exercise": ["accuracy"], "quality": ["accuracy"], "phase": ["accuracy"]},
    )
    return model
