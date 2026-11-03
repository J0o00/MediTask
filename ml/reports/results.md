# MediTask model comparison (2026-11-03 12:32)


Dataset: 3057 sequences (3057 real), 20 subjects, sources {'ui_prmd': 2000, 'rehab24_6': 1057}.
Participant-wise split: train 2122 / val 316 / test 619 sequences. Model selection on validation quality macro-F1.

| Model | Method | Params | Exercise macro-F1 | Quality accuracy | Quality macro-F1 | Latency (ms/rep) |
|---|---|---|---|---|---|---|
| A | Rule-based (app thresholds) | - | - | 0.496 | 0.551 | - |
| A2 | DTW 1-NN (joint angles) | - | 0.889 | 0.619 | 0.613 | 1428.30 |
| B | LSTM coords | 240,277 | 0.950 | 0.722 | 0.722 | 6.13 |
| C | GRU coords | 185,493 | 0.976 | 0.724 | 0.724 | 5.16 |
| D | GRU hybrid | 198,549 | 0.936 | 0.672 | 0.666 | 5.55 |
| E | LSTM hybrid | 257,685 | 0.941 | 0.614 | 0.603 | 7.20 |

Selected for deployment: **gru_coords** (validation quality macro-F1 0.656).

Per-class recall (quality, test):

- A_rules: correct 0.39 (n=77), incorrect 0.68 (n=44), incomplete 0.00 (n=0)
- A2_dtw_1nn: correct 0.70 (n=324), incorrect 0.53 (n=295), incomplete 0.00 (n=0)
- B_lstm_coords: correct 0.68 (n=324), incorrect 0.77 (n=295), incomplete 0.00 (n=0)
- C_gru_coords: correct 0.69 (n=324), incorrect 0.76 (n=295), incomplete 0.00 (n=0)
- D_gru_hybrid: correct 0.52 (n=324), incorrect 0.84 (n=295), incomplete 0.00 (n=0)
- E_lstm_hybrid: correct 0.43 (n=324), incorrect 0.82 (n=295), incomplete 0.00 (n=0)

Quality accuracy by exercise, test set (gru_coords):

| Exercise | Test reps | Accuracy | Macro-F1 |
|---|---|---|---|
| arm_abduction | 81 | 0.568 | 0.518 |
| arm_vw | 47 | 0.851 | 0.850 |
| forward_lunge | 40 | 0.500 | 0.333 |
| hurdle_step | 40 | 0.925 | 0.925 |
| inline_lunge | 40 | 0.625 | 0.625 |
| lateral_leg_raise | 41 | 0.707 | 0.693 |
| push_up | 10 | 0.500 | 0.333 |
| shoulder_extension | 40 | 0.900 | 0.899 |
| shoulder_rotation | 40 | 0.750 | 0.733 |
| shoulder_scaption | 40 | 0.975 | 0.975 |
| side_lunge | 40 | 0.825 | 0.819 |
| sit_to_stand | 40 | 0.850 | 0.847 |
| squat | 80 | 0.537 | 0.496 |
| standing_leg_raise | 40 | 0.775 | 0.775 |

Environment: Python 3.13.18, Linux-6.18.44-fc-v230-x86_64-with-glibc2.39
Latency: neural models = reference forward pass (NumPy, same algorithm as the browser code) per repetition; DTW = pure-Python per test sequence. In-browser latency is logged per session (summary.avgModelLatencyMs).
