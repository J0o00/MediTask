# Testing

## Automated

| Command | What it checks |
|---|---|
| `npm test` | Engine unit tests (`tests/exercise-tests`): geometry, normalisation invariance, rule detection, rep counting (complete / incomplete / jitter), full sessions with sets, confidence gating, features, DTW, digital twin. Parity (`tests/parity`): JS ≡ Python for normalisation, metrics, features, phase labels and DTW (≤ 1e-9); JS GRU/LSTM inference ≡ Keras (≤ 1e-4) |
| `python3 -m http.server 8765` then `npm run test:e2e` | Browser end-to-end (Playwright/Chromium) with an in-memory fake Firebase and stub MediaPipe feeding synthetic squats: full patient session (3 reps detected, session record, prescription completed, +10 points, pain feedback → alert, XSS-safe chat) and the physiotherapist dashboard (patient scoping, twin tiles, alerts, sessions, prescribing, PDF, invitations). Set `E2E_TW_CSS` to a compiled Tailwind file for realistic screenshots in `tests/e2e/out/` |
| `npm run test:rules` | `tests/security-tests`: authorisation boundaries on the Firestore emulator — cross-patient reads, doctor scoping, role/doctor self-assignment, point tampering, valid and invalid completion batches, duplicate session writes, prescribing, chat spoofing, consent-based linking, deletes. Needs Java; the emulator is downloaded on first run |
| `cd ml && python -m meditask_ml.dataset --synthetic --out data/processed_synthetic && python -m meditask_ml.run_experiments --data data/processed_synthetic --quick --no-export` | Whole ML pipeline end to end (build → split → 6 models → report) |
| `cd ml && python scripts/make_parity_fixtures.py --model models/<name>` | Regenerates parity fixtures for a newly trained model (also asserts NumPy reference ≡ Keras) |

Run `npm run test:rules` before every deployment of `firestore.rules`.

## Manual test protocol (app)

### Functional
1. Doctor A signs up; invites patient P (existing account) → P sees invitation → accepts → appears in A's list.
2. Doctor B tries to view P → not listed; direct URL / console reads are rejected.
3. A assigns *Squat 2 × 5* → P completes it → prescription disappears, +10 points, session visible to A with per-rep table.
4. P ends a session early → saved as *stopped*, prescription stays active, no points.
5. P presses **STOP** → alert appears for A; acknowledge clears it.
6. P reports pain 8 → `pain` alert; report pain ≥ baseline + 3 → `pain_increase`.
7. Disconnect network at the end of a session → "saved on this device" → reconnect and reload → uploaded once.
8. Chat: send `<img src=x onerror=alert(1)>` → rendered as text.

### Robustness (record results in a table: condition × exercise × detected reps × true reps)
* Lighting: daylight, indoor lamp, back-lit window, dim.
* Camera: 1.5 m / 2 m / 3 m; frontal, 30° and 60° to the side; laptop height vs floor level.
* Clothing: fitted vs loose; partial occlusion (chair, table).
* Expected behaviour: when required joints are not visible the app pauses scoring and shows a repositioning message
  rather than counting or correcting.

### Rep-counting accuracy
For each exercise, ≥ 3 participants × 3 sets × 10 reps, including deliberate partial reps. A second observer counts
from video. Report precision = correct detections / detections, recall = correct detections / true reps, F1, and how
partial reps were classified.

### Performance
Session documents store `summary.fps`, `avgPoseLatencyMs`, `avgModelLatencyMs` and `lowConfidencePct`. Collect these
across devices (laptop, mid-range Android phone) and report median and 10th percentile fps.
