# Research methodology

**Title.** Design and Development of an AI-Assisted Computer Vision-Based Tele-Rehabilitation System with
Biomechanical Movement Analysis and Digital Rehabilitation Monitoring (*MEDiTASK*).

**Research question.** Can temporal movement analysis (GRU/LSTM over biomechanical feature sequences) identify
incorrect and incomplete rehabilitation exercise repetitions better than conventional threshold-based pose analysis?

## 1. Objectives
1. Real-time human pose estimation for rehabilitation exercise monitoring (MediaPipe Pose, in-browser).
2. Biomechanical feature extraction from body landmarks (joint angles, kinematics, symmetry).
3. Temporal movement analysis for exercise recognition and quality assessment (GRU/LSTM, multi-task).
4. Patient-specific rehabilitation monitoring (digital rehabilitation twin).
5. Quantitative evaluation (accuracy, precision, recall, macro-F1, latency, model size).
6. A secure patient–physiotherapist platform.

## 2. Sample definition
One sample = **one repetition**, segmented by the same state machine the app uses live (or provided pre-segmented
by the dataset), **resampled to 30 frames**. Each frame has **82 features**:

| Indices | Group | Definition |
|---|---|---|
| 0–35 | Coordinates | 12 joints × (x, y, z) after normalisation (mid-hip origin, torso-length unit, yaw-aligned) |
| 36–45 | Joint angles | L/R elbow, L/R shoulder elevation, L/R hip, L/R knee, trunk inclination, shoulder tilt (÷180) |
| 46–55 | Angular velocity | first difference of the scaled angles |
| 56–65 | Angular acceleration | second difference |
| 66–69 | Symmetry | \|L − R\| for elbow, shoulder, hip, knee (÷180) |
| 70–81 | Confidence | landmark visibility (1.0 for motion capture) |

Tensor: **X ∈ ℝ^(N × 30 × 82)**. The 12-joint skeleton is the intersection of MediaPipe, Kinect v2 and the UI-PRMD
skeleton, which is what makes the public datasets combinable. Identical code exists in JS and Python; `tests/parity`
checks they agree to 1e-9.

**Labels:** exercise class (taxonomy in `ml/config/label_taxonomy.json`); quality ∈ {correct, incorrect, incomplete};
per-frame phase ∈ {rest, outward, hold, return} — *weak* labels derived from the primary joint trajectory (no public
dataset annotates phases).

## 3. Dataset strategy (target: 6,000 independent sequences)

| Source | Raw repetitions | Labels | Notes |
|---|---|---|---|
| KIMORE | ~2,806 (after segmentation) | clinical scores → correct/incorrect by threshold | Kinect v2; continuous recordings segmented with the app's state machine |
| UI-PRMD | 1,326 | correct / incorrect | Kinect; healthy subjects performing deliberate errors |
| REHAB24-6 | 1,072 | correct / incorrect | physiotherapist-supervised; prepare `manifest.csv` |
| MediTask custom | ≥ 796 needed | correct / incorrect / incomplete, error variant | `collect.html`, consented healthy volunteers, physiotherapist-confirmed labels |

* Counts above are what the sources report; the number retained after harmonisation is printed by
  `meditask_ml.dataset` (`dataset_summary.json → real_independent_sequences`, `remaining_to_target`).
* **Augmentation** (time-warp, end-cropping, coordinate and confidence jitter) is applied to the training split only and
  never counted toward 6,000.
* **Synthetic** data exists only to test the pipeline.
* Verify every `VERIFY` note in the adapters (file layouts, joint orders, KIMORE score scale) and each dataset's licence.

## 4. Splitting
Participant-wise (no subject in two splits): **70 % train / 10 % validation / 20 % test**. Among 200 random group
splits the one whose exercise × quality distribution best matches the full set is kept; all exercise classes must
appear in training. The test set is used once, after model selection on validation.

## 5. Models compared

| | Model | Input |
|---|---|---|
| A | Rule-based baseline: the app's thresholds + biomechanical rules | angles from coordinates |
| A2 | DTW 1-nearest-neighbour (Sakoe–Chiba band 20 %) | 10 joint angles |
| B | LSTM 2 × 128 | coordinates + confidence (48) |
| C | GRU 2 × 128 | coordinates + confidence (48) |
| **D** | **GRU 2 × 128 — hybrid (proposed)** | all 82 features |
| E | LSTM 2 × 128 — hybrid | all 82 features |

Neural architecture: 2 recurrent layers (return sequences, dropout 0.3) → per-frame phase head; global average ‖
max pooling → Dense 64 ReLU → exercise and quality heads. Adam 1e-3, batch 32, ≤ 100 epochs, early stopping
(patience 10, restore best), losses weighted exercise 1 / quality 1 / phase 0.5, balanced class weights.
Comparisons B↔C and D↔E isolate GRU vs LSTM; B↔E and C↔D isolate the contribution of biomechanical features.

## 6. Evaluation
* Classification: accuracy, macro precision/recall/**F1** (headline, because classes are imbalanced), per-class recall,
  confusion matrices — for exercise, quality and phase.
* Efficiency: parameters, weight size, per-repetition inference latency (reference forward pass; in-browser latency and
  fps are logged in every session).
* Rep counting (app-level): manually counted repetitions vs detected → precision, recall, F1 (protocol in [testing.md](testing.md)).
* ROM: webcam angle vs goniometer / motion capture → mean absolute error and Bland–Altman — **required before any
  clinical claim**.

`python -m meditask_ml.run_experiments` writes `ml/reports/results.md` (the results-chapter table) and
`results.json`, confusion matrices and training curves per model.

## 7. Ethics and safety
Institutional approval and informed consent for all recordings; anonymous subject IDs; healthy volunteers for
deliberately incorrect movements; video never leaves the device (only skeleton coordinates). The system is decision
support: exercise changes remain with the physiotherapist.

## 8. Expected contributions
1. A modular, configuration-driven rehabilitation movement-analysis engine.
2. A cross-dataset harmonised temporal representation (common 12-joint skeleton, 82 features).
3. An experimental comparison of threshold-based vs temporal (GRU/LSTM) movement assessment, with and without biomechanical features.
4. A patient-specific rehabilitation progress model (digital twin).
5. A working, secured tele-rehabilitation application with verified browser inference.
