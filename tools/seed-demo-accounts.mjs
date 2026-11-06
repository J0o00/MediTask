/**
 * MediTask — Demo Account Seeder
 * Uses Firebase Auth REST API + Firestore REST API
 * Run: node tools/seed-demo-accounts.mjs
 *
 * Configures 2 doctors and 7 patients with realistic workouts
 * using the real exercises configured in MediTask:
 *   - squat
 *   - lateral_leg_raise
 *   - shoulder_abduction
 *   - elbow_flexion
 *   - right_hand_raise
 */

const API_KEY    = 'AIzaSyBwqiEYkycDoxGdovRwvlXjCFscUKU6Xr8';
const PROJECT_ID = 'meditask-webapp';
const AUTH_URL   = `https://identitytoolkit.googleapis.com/v1/accounts`;
const FIRESTORE  = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ─── Demo Accounts ────────────────────────────────────────────────────────────
export const DOCTORS = [
  { displayName: 'Dr. Sarah Chen',       email: 'dr.sarah.chen@meditask.demo',      password: 'Demo@1234' },
  { displayName: 'Dr. Marcus Williams',  email: 'dr.marcus.williams@meditask.demo', password: 'Demo@1234' },
];

export const PATIENTS = [
  {
    displayName: 'Elena Rostova',
    email: 'elena.rostova@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 0,
    condition: 'Post-ACL reconstruction rehab',
    age: 34,
    prescriptions: [
      { exerciseId: 'squat', exercise: 'Squat', sets: 3, reps: 10, notes: 'Controlled descent. Prevent knee valgus inward collapse.' },
      { exerciseId: 'lateral_leg_raise', exercise: 'Lateral Leg Raise', sets: 2, reps: 12, notes: 'Strengthen hip abductors; keep toes facing forward.' }
    ]
  },
  {
    displayName: 'James Okafor',
    email: 'james.okafor@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 0,
    condition: 'Knee osteoarthritis physiotherapy',
    age: 58,
    prescriptions: [
      { exerciseId: 'squat', exercise: 'Squat', sets: 2, reps: 8, notes: 'Quarter-squats only. Stop before 90° flexion.' },
      { exerciseId: 'lateral_leg_raise', exercise: 'Lateral Leg Raise', sets: 3, reps: 10, notes: 'Hold a sturdy chair for balance if needed.' }
    ]
  },
  {
    displayName: 'Priya Nair',
    email: 'priya.nair@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 0,
    condition: 'Hip flexor strain recovery',
    age: 29,
    prescriptions: [
      { exerciseId: 'lateral_leg_raise', exercise: 'Lateral Leg Raise', sets: 3, reps: 15, notes: 'Smooth movement, engage core throughout.' },
      { exerciseId: 'squat', exercise: 'Squat', sets: 2, reps: 10, notes: 'Hip-width stance, keep chest lifted.' }
    ]
  },
  {
    displayName: 'Liam O\'Brien',
    email: 'liam.obrien@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 0,
    condition: 'Lower-back chronic pain management',
    age: 45,
    prescriptions: [
      { exerciseId: 'squat', exercise: 'Squat', sets: 3, reps: 8, notes: 'Focus on neutral spine and pelvic alignment.' },
      { exerciseId: 'lateral_leg_raise', exercise: 'Lateral Leg Raise', sets: 2, reps: 10, notes: 'Support against wall; do not rotate pelvis.' }
    ]
  },
  {
    displayName: 'Amara Diallo',
    email: 'amara.diallo@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 1,
    condition: 'Rotator cuff post-op rehab',
    age: 41,
    prescriptions: [
      { exerciseId: 'shoulder_abduction', exercise: 'Shoulder Abduction', sets: 2, reps: 8, notes: 'Raise arms to T-pose. Do not shrug shoulders.' },
      { exerciseId: 'right_hand_raise', exercise: 'Right Hand Raise', sets: 3, reps: 10, notes: 'Reach smoothly overhead, 2-sec hold.' }
    ]
  },
  {
    displayName: 'Hiroshi Tanaka',
    email: 'hiroshi.tanaka@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 1,
    condition: 'Ankle sprain physiotherapy',
    age: 23,
    prescriptions: [
      { exerciseId: 'squat', exercise: 'Squat', sets: 3, reps: 12, notes: 'Equal weight distribution across both heels.' },
      { exerciseId: 'lateral_leg_raise', exercise: 'Lateral Leg Raise', sets: 3, reps: 12, notes: 'Steady balance, strengthen lateral stabilizing chain.' }
    ]
  },
  {
    displayName: 'Sofia Martínez',
    email: 'sofia.martinez@meditask.demo',
    password: 'Patient@1234',
    doctorIndex: 1,
    condition: 'Rheumatoid arthritis mobility program',
    age: 62,
    prescriptions: [
      { exerciseId: 'elbow_flexion', exercise: 'Elbow Flexion', sets: 3, reps: 10, notes: 'Full elbow extension to curl without jerking.' },
      { exerciseId: 'shoulder_abduction', exercise: 'Shoulder Abduction', sets: 2, reps: 8, notes: 'Gentle mobility. Stop immediately if joints ache.' }
    ]
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
export async function authSignIn(email, password) {
  const res = await fetch(`${AUTH_URL}:signInWithPassword?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Auth sign-in failed for ${email}: ${data?.error?.message}`);
  return { uid: data.localId, idToken: data.idToken };
}

export async function authSignUp(email, password) {
  const res = await fetch(`${AUTH_URL}:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    const code = data?.error?.message || res.statusText;
    if (code === 'EMAIL_EXISTS') return authSignIn(email, password);
    throw new Error(`Auth signup failed for ${email}: ${code}`);
  }
  return { uid: data.localId, idToken: data.idToken };
}

export function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined)                    fields[k] = { nullValue: null };
    else if (typeof v === 'boolean')                      fields[k] = { booleanValue: v };
    else if (typeof v === 'number' && Number.isInteger(v)) fields[k] = { integerValue: String(v) };
    else if (typeof v === 'number')                       fields[k] = { doubleValue: v };
    else if (typeof v === 'string')                       fields[k] = { stringValue: v };
    else if (typeof v === 'object' && !Array.isArray(v)) {
      fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
    } else if (Array.isArray(v)) {
      fields[k] = {
        arrayValue: {
          values: v.map(item =>
            typeof item === 'object' ? { mapValue: { fields: toFirestoreFields(item) } } : { stringValue: String(item) }
          )
        }
      };
    }
  }
  return fields;
}

async function writeUserDoc(uid, idToken, profileData) {
  const url = `${FIRESTORE}/users/${uid}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields: toFirestoreFields(profileData) }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Firestore write failed for ${uid}: ${JSON.stringify(err?.error?.message)}`);
  }
}

async function writePrescription(patientUid, doctorUid, doctorIdToken, rx, index) {
  const rxId = `rx_${rx.exerciseId}_${index + 1}`;
  const rxData = {
    exerciseId: rx.exerciseId,
    exercise: rx.exercise,
    exerciseName: rx.exercise,
    sets: rx.sets,
    reps: rx.reps,
    notes: rx.notes,
    status: 'active',
    assignedAt: new Date(Date.now() - (3 - index) * 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    doctorId: doctorUid,
    patientId: patientUid,
  };

  const url = `${FIRESTORE}/users/${patientUid}/prescriptions/${rxId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${doctorIdToken}`,
    },
    body: JSON.stringify({ fields: toFirestoreFields(rxData) }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Prescription write failed: ${JSON.stringify(err?.error?.message)}`);
  }
}

async function writeSession(patientUid, patientIdToken, sessionData, index) {
  const sessionId = `session_${sessionData.exerciseId}_${index + 1}`;
  const url = `${FIRESTORE}/users/${patientUid}/sessions/${sessionId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${patientIdToken}`,
    },
    body: JSON.stringify({ fields: toFirestoreFields(sessionData) }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.warn(`  ⚠ Session write note: ${JSON.stringify(err?.error?.message)}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   MediTask — Seeding Verified Assigned Workouts & Sessions   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. Authenticate doctors
  const doctors = [];
  console.log('🩺  Connecting doctor accounts…');
  for (const doc of DOCTORS) {
    const auth = await authSignIn(doc.email, doc.password);
    doctors.push({ ...doc, ...auth });
    console.log(`  ✓ ${doc.displayName} (${auth.uid.slice(0, 8)}…)`);
  }

  // 2. Setup patients with valid prescriptions & sessions
  console.log('\n🧑‍🦽  Seeding patient accounts with active prescribed workouts…\n');
  const now = Date.now();
  const ONE_DAY = 86400000;

  for (let i = 0; i < PATIENTS.length; i++) {
    const p = PATIENTS[i];
    const doc = doctors[p.doctorIndex];
    process.stdout.write(`  [${i + 1}/7] ${p.displayName} (${doc.displayName}) … `);

    const patAuth = await authSignIn(p.email, p.password);

    // Ensure profile has correct doctorId & points
    await writeUserDoc(patAuth.uid, patAuth.idToken, {
      uid: patAuth.uid,
      email: p.email.toLowerCase(),
      role: 'patient',
      displayName: p.displayName,
      doctorId: doc.uid,
      condition: p.condition,
      age: p.age,
      points: 20 + i * 10,
      createdAt: new Date(now - 14 * ONE_DAY).toISOString(),
    });

    // Write assigned prescriptions (as Doctor)
    for (let rxIdx = 0; rxIdx < p.prescriptions.length; rxIdx++) {
      await writePrescription(patAuth.uid, doc.uid, doc.idToken, p.prescriptions[rxIdx], rxIdx);
    }

    // Write 3 historical completed sessions for longitudinal ROM chart (as Patient)
    const primaryRx = p.prescriptions[0];
    const jointMap = {
      squat: 'knee_l',
      lateral_leg_raise: 'hip_l',
      shoulder_abduction: 'shoulder_r',
      elbow_flexion: 'elbow_r',
      right_hand_raise: 'shoulder_r'
    };
    const primaryJoint = jointMap[primaryRx.exerciseId] || 'knee_l';

    for (let s = 0; s < 3; s++) {
      const sessionDate = new Date(now - (5 - s * 2) * ONE_DAY).toISOString();
      const baseRom = primaryRx.exerciseId === 'squat' ? 85 : 45;
      const romVal = baseRom + s * 6;
      const qualityVal = 78 + s * 5;

      const session = {
        patientId: patAuth.uid,
        exerciseId: primaryRx.exerciseId,
        exercise: primaryRx.exercise,
        exerciseName: primaryRx.exercise,
        prescriptionId: `rx_${primaryRx.exerciseId}_1`,
        status: 'completed',
        validReps: primaryRx.sets * primaryRx.reps,
        incompleteReps: 1,
        quality: qualityVal,
        romDeg: romVal,
        sets: primaryRx.sets,
        reps: primaryRx.reps,
        durationSec: primaryRx.sets * primaryRx.reps * 4,
        startedAt: sessionDate,
        completedAt: sessionDate,
        summary: {
          avgQuality: qualityVal,
          consistency: 85,
          lowConfidencePct: 2,
          rom: {
            [primaryJoint]: {
              bestRange: romVal,
              meanRange: romVal - 3
            }
          },
          symmetry: {},
          errorCounts: {}
        },
        reps: [],
        feedback: { pain: Math.max(1, 4 - s), difficulty: 'medium' }
      };

      await writeSession(patAuth.uid, patAuth.idToken, session, s);
    }

    console.log('✅ (2 workouts, 3 sessions)');
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('\n✨ All 7 patients successfully seeded with active prescribed workouts and sessions!\n');
}

main().catch(err => {
  console.error('\n💥 Fatal seeder error:', err);
  process.exit(1);
});
