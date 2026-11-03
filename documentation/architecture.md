# Architecture

## Layers

```mermaid
flowchart TB
    subgraph Presentation
        P[patient-dashboard.html<br/>patient-app.js]
        D[doctor-dashboard.html<br/>doctor-app.js]
        C[collect.html<br/>research recorder]
    end
    subgraph Engine["Rehabilitation intelligence engine (browser, no network)"]
        PE[pose-engine.js<br/>RehabSession]
        SK[skeleton.js] --> AC[angle-calculator.js]
        MF[movement-filter.js<br/>One-Euro]
        LV[landmark-validator.js]
        RC[repetition-counter.js<br/>4-phase FSM]
        ME[movement-evaluator.js<br/>rules + quality]
        FB[feedback-engine.js<br/>text + voice]
        FE[feature-extractor.js]
        DTW[dtw-analyzer.js]
        CL[movement-classifier.js<br/>GRU / LSTM]
        RA[rehabilitation-analytics.js]
    end
    TW[digital-twin/progress-model.js]
    subgraph Backend[Firebase]
        AU[Authentication]
        FS[(Firestore<br/>role + relationship rules)]
    end
    ML[ml/ Python pipeline<br/>train · evaluate · export] -. meditask_model.json/.bin .-> CL
    P --> PE
    C --> PE
    PE --> SK & MF & LV & RC & ME & FB & DTW & CL & RA
    CL --> FE
    P & D --> TW
    P & D --> FS
    P & D --> AU
```

## Per-frame pipeline (≈ 30 fps)

1. **MediaPipe Pose** (browser) → 33 image + world landmarks.
2. **Common skeleton** (`skeleton.js`): 12 joints, world coordinates converted to right-handed, y-up.
3. **Confidence gate** (`landmark-validator.js`): required joints for the exercise must have visibility ≥ 0.6 and be in frame.
   Otherwise scoring pauses and the patient is told which joints are not visible. Tracking lost for > 1.5 s mid-rep discards the rep.
4. **One-Euro filter** per coordinate: removes jitter with little lag.
5. **Normalisation**: origin at mid-hip, unit = torso length, rotated so the subject faces +z — invariant to position, body size and camera angle.
6. **Metrics** (`angle-calculator.js`): 3-D joint angles plus derived measures (arm elevation plane, hip abduction/flexion, knee-width ratio…).
7. **Progress** along the prescribed range (0 = rest, 1 = target) → **repetition state machine** with hysteresis:
   `rest → outward → hold → return → rest` (complete) or `rest → outward → rest` past 50 % (incomplete).
8. **Rules** (declarative, per exercise and phase) → active error codes → live form score, per-joint colouring, one prioritised instruction (optionally spoken).

## Per-repetition pipeline

* **Quality score** (0–100): ROM attainment 35 %, persistent rule violations 35 %, tempo 10 %, smoothness 10 %, DTW similarity 10 %.
  Label: `correct` (≥ 75 and no persistent moderate/major error), `incorrect`, or `incomplete` (target not reached).
* **DTW** of the progress curve against a therapist template (or an idealised curve).
* **GRU/LSTM** (if a model is installed): the repetition is resampled to 30 frames × 82 features and classified
  (exercise, quality, per-frame phase). Predictions below 60 % confidence are not shown to the patient; a confident
  exercise mismatch triggers a hint.

## Session record

At the end of a session (`buildRecord`) one standardised document is written: per-rep records (label, quality, ROM,
symmetry, errors, DTW, ML output) and a summary (ROM, consistency, error counts, experimental performance-decline
indicator, fps, pose and model latency, low-confidence %). See [data-model.md](data-model.md).

## Digital twin

`progress-model.js` rebuilds the twin from session records on demand (single source of truth): per-exercise timeline
of ROM, quality, symmetry and pain; personal baseline (first 3 sessions); current (last 5); change vs baseline;
least-squares trend; review flags (quality/ROM decline, high or rising pain).

## Why plain-JS inference instead of TensorFlow.js
The model is small (≈ 200 k parameters). Implementing the GRU/LSTM forward pass directly (~100 lines) removes a
1 MB+ dependency and the fragile Keras 3 → TF.js conversion step, and lets Node tests prove that browser
outputs equal Keras outputs (`tests/parity`).
