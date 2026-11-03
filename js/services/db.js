// MediTask data-access layer. Every query here is shaped so that the
// security rules in firestore.rules can prove it is allowed.
import { db } from "./auth.js";
import {
    collection, query, where, getDocs, getDoc, orderBy, limit, addDoc, setDoc, updateDoc,
    doc, onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const USERS = "users";
const LINKS = "link_requests";
const sub = (pid, name) => collection(db, USERS, pid, name);

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ------------------------------------------------------------------ profiles
export async function getProfile(uid) {
    const s = await getDoc(doc(db, USERS, uid));
    return s.exists() ? { uid: s.id, ...s.data() } : null;
}

export async function updateOwnProfile(uid, fields) {
    const allowed = ['displayName', 'consent', 'voiceEnabled'];
    const data = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
    return updateDoc(doc(db, USERS, uid), { ...data, updatedAt: serverTimestamp() });
}

// ------------------------------------------------------------------ doctor: patients
/** Only patients assigned to this doctor (rules reject any other query). */
export async function getMyPatients(doctorId) {
    const q = query(collection(db, USERS), where("doctorId", "==", doctorId));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(p => p.role === 'patient');
}

export async function unlinkPatient(patientId) {
    return updateDoc(doc(db, USERS, patientId), { doctorId: null, updatedAt: serverTimestamp() });
}

// ------------------------------------------------------------------ link requests
export async function createLinkRequest(doctor, patientEmail) {
    const email = patientEmail.trim().toLowerCase();
    // Avoid duplicate pending invitations from the same doctor.
    const existing = await getDocs(query(collection(db, LINKS),
        where("doctorId", "==", doctor.uid), where("status", "==", "pending")));
    if (existing.docs.some(d => d.data().patientEmail === email)) {
        throw new Error("An invitation to this email is already pending.");
    }
    return addDoc(collection(db, LINKS), {
        doctorId: doctor.uid,
        doctorEmail: doctor.email,
        doctorName: doctor.displayName || doctor.email,
        patientEmail: email,
        status: 'pending',
        createdAt: serverTimestamp(),
    });
}

export async function getDoctorPendingLinks(doctorId) {
    const snap = await getDocs(query(collection(db, LINKS),
        where("doctorId", "==", doctorId), where("status", "==", "pending")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function cancelLinkRequest(reqId) {
    return updateDoc(doc(db, LINKS, reqId), { status: 'cancelled', respondedAt: serverTimestamp() });
}

export async function getMyPendingLinkRequests(email) {
    const snap = await getDocs(query(collection(db, LINKS),
        where("patientEmail", "==", email.toLowerCase()), where("status", "==", "pending")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Patient consents to a doctor. Atomic: request -> accepted, profile -> doctorId. */
export async function respondToLinkRequest(patientId, request, accept) {
    const batch = writeBatch(db);
    batch.update(doc(db, LINKS, request.id), { status: accept ? 'accepted' : 'declined', respondedAt: serverTimestamp() });
    if (accept) {
        batch.update(doc(db, USERS, patientId), {
            doctorId: request.doctorId, linkRequestId: request.id, updatedAt: serverTimestamp()
        });
    }
    return batch.commit();
}

// ------------------------------------------------------------------ prescriptions
export async function assignPrescription(doctorId, patientId, { exerciseId, exercise, sets, reps, notes = '' }) {
    return addDoc(sub(patientId, 'prescriptions'), {
        doctorId, patientId, exerciseId, exercise,
        sets: Math.round(sets), reps: Math.round(reps), notes: String(notes).slice(0, 500),
        status: 'active', assignedAt: serverTimestamp(),
    });
}

export async function updatePrescription(patientId, rxId, fields) {
    return updateDoc(doc(db, USERS, patientId, 'prescriptions', rxId), { ...fields, updatedAt: serverTimestamp() });
}

export async function getPrescriptions(patientId, status = 'active') {
    const q = query(sub(patientId, 'prescriptions'), where("status", "==", status), orderBy("assignedAt", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ------------------------------------------------------------------ sessions
export async function getSessions(patientId, max = 100) {
    const q = query(sub(patientId, 'sessions'), orderBy("startedAt", "desc"), limit(max));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Save a finished session. If it completes the prescription, the same atomic
 * batch marks the prescription completed and awards points - the rules only
 * accept the reward when all three writes are consistent.
 * The session id is generated before the session starts, so a retry can
 * never create a duplicate record.
 */
export async function saveSession(patient, session, prescription) {
    const batch = writeBatch(db);
    const sessionRef = doc(db, USERS, patient.uid, 'sessions', session.id);
    const { id, ...data } = session;
    batch.set(sessionRef, { ...data, patientId: patient.uid, savedAt: serverTimestamp() });

    let pointsEarned = 0;
    const meetsTarget = prescription && session.status === 'completed'
        && session.validReps >= prescription.sets * prescription.reps;
    if (meetsTarget) {
        batch.update(doc(db, USERS, patient.uid, 'prescriptions', prescription.id), {
            status: 'completed', completedAt: serverTimestamp(),
            lastSessionId: session.id, totalRepsCompleted: session.validReps,
        });
        if (patient.lastRewardedPrescription !== prescription.id) {
            pointsEarned = 10;
            batch.update(doc(db, USERS, patient.uid), {
                points: (patient.points || 0) + pointsEarned,
                lastRewardedPrescription: prescription.id,
                updatedAt: serverTimestamp(),
            });
        }
    }
    await batch.commit();
    return { pointsEarned };
}

export async function addSessionFeedback(patientId, sessionId, feedback, flags = {}) {
    return updateDoc(doc(db, USERS, patientId, 'sessions', sessionId), {
        feedback: {
            pain: Math.max(0, Math.min(10, Math.round(feedback.pain))),
            difficulty: feedback.difficulty,
            notes: String(feedback.notes || '').slice(0, 1000),
        },
        flags,
    });
}

export async function addSessionReview(patientId, sessionId, text) {
    return updateDoc(doc(db, USERS, patientId, 'sessions', sessionId), {
        review: { text: String(text).slice(0, 2000), at: new Date().toISOString() },
    });
}

// ------------------------------------------------------------------ alerts
export async function raiseAlert(patientId, type, message, sessionId = null) {
    return addDoc(sub(patientId, 'alerts'), {
        type, message: String(message).slice(0, 500), sessionId,
        acknowledged: false, createdAt: serverTimestamp(),
    });
}

export async function getOpenAlerts(patientId) {
    const q = query(sub(patientId, 'alerts'), where("acknowledged", "==", false), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function acknowledgeAlert(patientId, alertId) {
    return updateDoc(doc(db, USERS, patientId, 'alerts', alertId), { acknowledged: true, acknowledgedAt: serverTimestamp() });
}

// ------------------------------------------------------------------ chat
/** Server-side scoped: only this patient's thread is ever downloaded. */
export function subscribeToChat(patientId, callback, onError = console.error) {
    const q = query(sub(patientId, 'messages'), orderBy("createdAt", "asc"), limit(300));
    return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
}

export async function sendMessage(patientId, sender, text) {
    const clean = String(text).trim().slice(0, 2000);
    if (!clean) return null;
    return addDoc(sub(patientId, 'messages'), {
        senderId: sender.uid,
        senderRole: sender.role,
        senderName: sender.displayName || sender.email,
        text: clean,
        createdAt: serverTimestamp(),
    });
}

export { setDoc };
