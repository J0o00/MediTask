# MediTask 2.0 — AI-assisted computer-vision tele-rehabilitation

MediTask connects patients and physiotherapists. Patients do their prescribed exercises in front of a
webcam; MediTask tracks their movement in the browser, counts repetitions, explains form errors in
real time, and records range of motion, movement quality and symmetry. Physiotherapists see each
patient's **digital rehabilitation twin** (their progress against their own baseline), review sessions,
respond to pain alerts and adjust prescriptions.

> MediTask **supports** physiotherapists. It does not diagnose conditions or change treatment by itself,
> and its webcam measurements have not been validated against clinical instruments.

---

## What changed from v1

| Area | v1 (prototype) | v2 (this version) |
|---|---|---|
| Security | Any signed-in user could read/write **every** document | Role- and relationship-based rules; patients see only their own data, doctors only their assigned patients; nothing clinical can be deleted |
| Doctor ↔ patient link | Doctor could overwrite anyone's doctor | Invitation the patient must **accept** (or the doctor creates the account) |
| Points | Client wrote any value | +10 only, once per prescription, only in the same atomic write that completes it with a session meeting the prescribed volume |
| Chat | Downloaded *all* messages, filtered in the browser; raw HTML injection | Per-patient thread queried server-side; text rendered safely |
| Exercises | 3 hard-coded `switch` functions | Configuration-driven engine (5 exercises, add more without new code) |
| Rep counting | Single threshold + 1-second debounce | Filtered 4-phase state machine with hysteresis; incomplete reps detected; tracking-loss handling |
| Scoring | Hand-assigned "accuracy %" | **Movement quality score** from ROM, persistent rule violations, tempo, smoothness and DTW similarity |
| Feedback | Generic messages | Explainable per-joint corrections, phase indicator, live joint angle, optional voice |
| Reliability | — | Landmark-confidence gating, One-Euro smoothing, idempotent session saves, offline queue |
| Safety | — | Consent screen, emergency STOP, pain escalation alerts, no sample prescriptions shown to patients |
| Analytics | Weekly count | Digital twin: ROM / quality / symmetry / pain trends vs personal baseline, review flags, PDF report |
| Interface | Dark neon theme, emoji icons, Tailwind CDN | Professional clinical theme: one design system (`css/app.css`, IBM Plex Sans, pine accent), SVG icons, accessible focus states, responsive to phone width; dashboards no longer depend on Tailwind |
| AI | — | Multi-task **GRU/LSTM** (exercise + quality + phase) trained in Python, run **in the browser** with verified parity |

---

## Quick start (web app)

1. **Firebase project** — the existing config in `js/config.js` points to `meditask-webapp`. To use your own,
   create a project, enable *Email/Password* sign-in and Firestore, and paste its web config into `js/config.js`.
2. **Deploy the security rules and indexes (required — the app's queries depend on them):**
   ```bash
   npm install
   npx firebase login
   npm run deploy:rules
   ```
3. **Run locally** (camera access needs `localhost` or HTTPS):
   ```bash
   npm start            # serves the folder, open http://localhost:3000
   ```
4. **Deploy:** `npm run deploy` (Firebase Hosting; `ml/`, `tests/`, docs are excluded from hosting).

Coming from v1 with existing data? See [documentation/data-model.md](documentation/data-model.md#migrating-from-v1)
and `tools/migrate-v1.mjs`.

### Using it
* **Physiotherapist:** sign up → *New patient account* (creates a linked login) or *Invite existing patient* →
  select the patient → *Prescriptions* tab → assign exercises → review *Digital twin* and *Sessions*, acknowledge alerts, export PDF.
* **Patient:** sign in → accept the invitation → consent screen → *Start* a prescription → follow the on-screen
  and (optional) voice feedback → session report → pain/difficulty feedback.
* **Researcher:** `collect.html` records labelled, auto-segmented repetitions for the training dataset.

---

## Project structure

```
MediTask/
├── index.html, login.html, signup.html        public pages
├── patient-dashboard.html, doctor-dashboard.html
├── collect.html                               research dataset recorder (local-only export)
├── css/app.css                                design system (tokens + components) for all app pages
├── firestore.rules, firestore.indexes.json    security + indexes (deploy these!)
├── js/
│   ├── config.js, patient-app.js, doctor-app.js
│   ├── services/        auth.js, db.js                      Firebase access layer
│   ├── rehabilitation/  skeleton, angle-calculator, movement-filter, landmark-validator,
│   │                    exercise-configs, repetition-counter, movement-evaluator,
│   │                    feedback-engine, pose-engine (orchestrator)
│   ├── intelligence/    feature-extractor, dtw-analyzer, movement-classifier (GRU/LSTM inference),
│   │                    rehabilitation-analytics
│   ├── digital-twin/    progress-model
│   └── ui/              dom (safe rendering), charts, exercise-visualizer, report-generator
├── models/web/          exported browser model goes here (none shipped by default)
├── models/templates/    optional therapist-recorded DTW references
├── ml/                  Python training pipeline  →  see ml/README.md
├── tests/               exercise-tests, parity (JS ≡ Python ≡ Keras), security-tests
├── tools/               export-configs.mjs, migrate-v1.mjs
└── documentation/       architecture, methodology, data model, testing
```

## Performance

* Tailwind is compiled ahead of time (`npm run build:css`, one theme per page in `tools/tailwind/`). This replaces the
  in-browser Tailwind compiler, about 300 KB of JS that blocked every page load.
* During a live session:
  * the `<video>` element shows the camera directly;
  * pose estimation runs one frame at a time (`requestVideoFrameCallback`);
  * the canvas draws only the skeleton;
  * heavy glass blur is switched off;
  * slow devices switch to the lighter pose model automatically.
* The icon and chart libraries are pinned to fixed versions and cached by the service worker (`sw.js`, cache v4).

## Tests

```bash
npm test                 # engine unit tests + JS/Python feature parity + JS/Keras model parity
npm run test:e2e         # browser end-to-end, 50 checks (serve the folder on :8765 first)
npm run test:rules       # security-rule tests on the Firestore emulator (needs Java)
cd ml && python -m meditask_ml.dataset --synthetic --out data/processed_synthetic \
      && python -m meditask_ml.run_experiments --data data/processed_synthetic --quick --no-export
```

## AI model

**A trained model ships with this version** (`models/web/meditask_model.json/.bin`, 725 KB, GRU on joint
coordinates). It runs in the browser through `js/intelligence/movement-classifier.js`, with no TensorFlow.js and no server.

**Training data (real recordings only, no synthetic data):** 3,057 labelled repetitions from 20 people:
UI-PRMD (Kinect, 10 exercises, 2,000 reps) and REHAB24-6 (optical motion capture, 6 exercises, 1,057 reps).
Everything is mapped to the common 12-joint skeleton. The split is **participant-wise**: 14 people for training,
2 for validation and 4 for testing, so the model is always scored on people it has never seen.

| Model | Exercise macro-F1 | Correct/incorrect accuracy | Latency per rep |
|---|---|---|---|
| Rule-based (app thresholds) | – | 0.50 | – |
| DTW 1-nearest-neighbour | 0.89 | 0.62 | 1,428 ms (Python) |
| LSTM, coordinates | 0.95 | 0.72 | 6 ms |
| **GRU, coordinates (deployed)** | **0.98** | **0.72** | **5 ms** |
| GRU, hybrid features | 0.94 | 0.67 | 6 ms |
| LSTM, hybrid features | 0.94 | 0.61 | 7 ms |

Full report: [ml/reports/results.md](ml/reports/results.md). In the browser, the model's output matches the
Keras model to within 1e-4 (`npm test`).

**What the app does with it.** The model was trained on the app's **squat** and **lateral leg raise**. On test
patients, its correct/incorrect verdict was reliable for the lateral leg raise (71%) but no better than chance for the
squat (54%). So:
* lateral leg raise: the model gives a second opinion on each repetition (badge: *AI model + rules*);
* squat: the model only checks that the patient is doing the right exercise, and the rule engine judges form (badge: *Rules + AI exercise check*);
* right-hand raise, shoulder abduction and elbow flexion: rule-based only, because no public dataset matched them.

**Important caveat.** The training data comes from Kinect and motion-capture systems, not webcams. Expect some loss
of accuracy on MediaPipe webcam input until the model is retrained with recordings made in `collect.html`.
How to retrain: [ml/README.md](ml/README.md).

## Status against the development plan

| Work package | Status |
|---|---|
| WP1 Rehabilitation intelligence engine | Done — modular, configuration-driven, tested |
| WP2 Advanced movement analysis | Done. One-Euro filtering, DTW, rule baseline, GRU/LSTM trained on 3,057 real reps (UI-PRMD + REHAB24-6); webcam recordings still needed |
| WP3 Digital rehabilitation twin | Done — longitudinal ROM / quality / symmetry / pain vs baseline |
| WP4 Patient & physiotherapist intelligence | Done — both dashboards upgraded |
| WP5 Security & reliability | Done — rules written and code paths aligned; **run `npm run test:rules` before go-live** |
| WP6 Experimental validation | Tooling done (metrics, splits, baselines, reports); data collection and expert labelling pending |

## Safety and limitations
* Thresholds in `exercise-configs.js` are engineering starting points and must be reviewed by a physiotherapist.
* The "movement quality score" is not clinical accuracy. ROM from a webcam must be validated against a goniometer or
  motion capture before any clinical claim.
* Rules prevent tampering with relationships, rewards and records, but the client still reports what the camera saw;
  a production deployment should move session validation and rewards into Cloud Functions and verify clinician accounts
  (custom claims) instead of trusting the self-selected "doctor" role.
* Research recordings require institutional ethics approval and informed consent.
