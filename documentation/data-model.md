# Data model and security

## Collections

```
users/{uid}
    uid, email (lower-case), role: 'patient' | 'doctor', displayName,
    doctorId (patients; null until linked), points, lastRewardedPrescription,
    consent {camera, version, at}, voiceEnabled, linkRequestId, createdAt, updatedAt

users/{patientId}/prescriptions/{rxId}
    doctorId, patientId, exerciseId, exercise (display name), sets, reps, notes,
    status: 'active' | 'completed' | 'cancelled', assignedAt, completedAt, lastSessionId, totalRepsCompleted

users/{patientId}/sessions/{sessionId}        (client-generated id, written once)
    patientId, prescriptionId, exerciseId, exercise, status: 'completed' | 'stopped' | 'interrupted',
    targetSets, targetReps, setsCompleted, validReps, incompleteReps, emergencyStop?,
    startedAt, endedAt, engineVersion,
    reps[]: { index, set, label, quality, durationMs, holdMs, peak, rom{joint:{min,max,range}},
              symmetry{}, errors[{id, fraction, severity}], components{rom, errors, tempo, smoothness, dtw},
              dtwDistance, ml{exercise, exerciseProb, quality, qualityProb, confident, exerciseMismatch} | null }
    summary: { totalReps, validReps, correctReps, incompleteReps, avgQuality, avgDurationMs, rom{}, symmetry{},
               consistency, errorCounts{}, qualitySlopePerRep, performanceDecline, fps, avgPoseLatencyMs,
               avgModelLatencyMs, lowConfidencePct, templateSource, mlModel }
    feedback: { pain 0-10, difficulty, notes } | null      (added once by the patient)
    flags: { highPain, painIncrease }
    review: { text, at }                                    (added by the doctor)

users/{patientId}/messages/{msgId}    senderId, senderRole, senderName, text (≤ 2000), createdAt (server time)
users/{patientId}/alerts/{alertId}    type: pain | pain_increase | emergency_stop | quality_decline,
                                      message, sessionId, acknowledged, createdAt, acknowledgedAt
link_requests/{id}                    doctorId, doctorEmail, doctorName, patientEmail, status, createdAt, respondedAt
```

Nesting clinical data under the patient means every rule is a path check ("is this my subtree / my patient's
subtree?"), so no query can leak another patient's records, and chat no longer downloads everyone's messages.

## Authorization summary (`firestore.rules`)

| Who | Can |
|---|---|
| Patient | read/update own profile (only display name, consent, voice); accept/decline invitations addressed to their e-mail; create sessions and alerts; add feedback to a session once; send messages; complete an active prescription **only** together with a completed session that meets sets × reps; receive exactly +10 points once per prescription in that same batch |
| Doctor | list/read only patients whose `doctorId` is them; create/edit/cancel prescriptions for them; read their sessions, messages, alerts; add a review note; acknowledge alerts; send invitations; unlink a patient |
| Anyone else | nothing; all other paths are closed; no deletes of clinical data |

Idempotent saves: the session id is generated when the session starts. A retried write with the same id is rejected
(it would be an update), so a flaky connection can never create two records or award points twice.

### Known limits (prototype)
* Anyone can register with role `doctor`. Production: verify clinicians and use custom auth claims.
* Session contents come from the patient's device. Rules guarantee consistency, not that the camera data is genuine.
  Production: validate and award points in a Cloud Function.

## Migrating from v1
v1 used flat `prescriptions`, `exercise_logs` and `messages` collections readable by everyone. After deploying the
new rules the v1 collections become unreadable to clients. Copy the data across once with the Admin SDK:

```bash
npm i -D firebase-admin
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node tools/migrate-v1.mjs --dry-run
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node tools/migrate-v1.mjs
```
Legacy completions become sessions marked `legacy: true` (no per-rep data). Delete the old collections after checking.
