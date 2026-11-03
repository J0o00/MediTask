// One-off migration from the MediTask v1 data model (flat collections) to v2
// (per-patient subcollections). Runs with the Firebase Admin SDK, which
// bypasses security rules - keep the service-account key private.
//
//   npm i -D firebase-admin
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node tools/migrate-v1.mjs --dry-run
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node tools/migrate-v1.mjs
//
// v1 -> v2
//   prescriptions/{id}            -> users/{patientId}/prescriptions/{id}   (isCompleted -> status, + exerciseId)
//   messages/{id}                 -> users/{patientId}/messages/{id}        (type -> senderRole, timestamp -> createdAt)
//   exercise_logs (completed:true)-> users/{patientId}/sessions/legacy-{id} (legacy: true, no per-rep data)
//   exercise_logs (type:feedback) -> merged into the nearest preceding legacy session as feedback
//   exercise_logs (per-rep rows)  -> dropped (superseded by the per-rep array inside sessions)
//   users/{uid}                   -> email lower-cased, doctorId defaulted to null
// The old collections are left untouched; delete them once you have checked the result.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveExercise } from '../js/rehabilitation/exercise-configs.js';

const DRY = process.argv.includes('--dry-run');
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

let ops = 0, batch = db.batch();
async function write(ref, data) {
    ops++;
    if (DRY) return;
    batch.set(ref, data, { merge: true });
    if (ops % 400 === 0) { await batch.commit(); batch = db.batch(); }
}

const users = await db.collection('users').get();
for (const u of users.docs) {
    const d = u.data();
    await write(u.ref, { email: String(d.email || '').toLowerCase(), doctorId: d.doctorId ?? null, role: String(d.role || '').toLowerCase() });
}

const rx = await db.collection('prescriptions').get();
for (const p of rx.docs) {
    const d = p.data();
    if (!d.patientId) continue;
    const cfg = resolveExercise(d.exercise);
    await write(db.doc(`users/${d.patientId}/prescriptions/${p.id}`), {
        doctorId: d.doctorId, patientId: d.patientId, exerciseId: cfg?.id || 'unknown', exercise: d.exercise,
        sets: d.sets, reps: d.reps, notes: '', status: d.isCompleted ? 'completed' : 'active',
        assignedAt: d.assignedAt || null, completedAt: d.completedAt || null, totalRepsCompleted: d.totalRepsCompleted || null,
    });
}

const msgs = await db.collection('messages').get();
for (const m of msgs.docs) {
    const d = m.data();
    if (!d.patientId) continue;
    await write(db.doc(`users/${d.patientId}/messages/${m.id}`), {
        senderId: d.senderId, senderRole: d.type === 'doctor_msg' ? 'doctor' : 'patient',
        senderName: d.senderName || '', text: String(d.text || '').slice(0, 2000), createdAt: d.timestamp || null,
    });
}

const logs = (await db.collection('exercise_logs').get()).docs.map(x => ({ id: x.id, ...x.data() }))
    .sort((a, b) => (a.timestamp?.toMillis?.() || 0) - (b.timestamp?.toMillis?.() || 0));
const lastSession = {};
for (const l of logs) {
    if (!l.patientId) continue;
    if (l.completed) {
        const cfg = resolveExercise(l.exercise);
        const id = `legacy-${l.id}`;
        lastSession[l.patientId] = id;
        await write(db.doc(`users/${l.patientId}/sessions/${id}`), {
            patientId: l.patientId, prescriptionId: null, exerciseId: cfg?.id || 'unknown', exercise: l.exercise,
            status: 'completed', validReps: 0, incompleteReps: 0, reps: [], summary: null, feedback: null,
            startedAt: l.timestamp || null, endedAt: l.timestamp || null, legacy: true, engineVersion: '1.x',
        });
    } else if (l.type === 'feedback' && lastSession[l.patientId]) {
        await write(db.doc(`users/${l.patientId}/sessions/${lastSession[l.patientId]}`), {
            feedback: { pain: Number(l.painLevel) || 0, difficulty: l.difficulty || 'medium', notes: l.notes || '' },
        });
    }
}

if (!DRY) await batch.commit();
console.log(`${DRY ? '[dry run] would write' : 'wrote'} ${ops} documents`);
