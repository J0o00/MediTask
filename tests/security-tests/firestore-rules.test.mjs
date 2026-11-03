// Authorization-boundary tests for firestore.rules.
// Requires the Firestore emulator:  npm run test:rules
// (skipped automatically when FIRESTORE_EMULATOR_HOST is not set)
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const skip = !HOST && 'FIRESTORE_EMULATOR_HOST not set - run `npm run test:rules`';

let env, F;
const DOC = 'doc-1', DOC2 = 'doc-2', PAT = 'pat-1', PAT2 = 'pat-2', STRANGER = 'eve';
const email = (u) => `${u}@example.com`;
const ctx = (uid) => env.authenticatedContext(uid, { email: email(uid) }).firestore();

before(async () => {
    if (skip) return;
    const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    F = await import('firebase/firestore');
    const [host, port] = HOST.split(':');
    env = await initializeTestEnvironment({ projectId: 'meditask-rules-test', firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: +port } });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
    if (skip) return;
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (c) => {
        const db = c.firestore();
        const { doc, setDoc } = F;
        await setDoc(doc(db, 'users', DOC), { role: 'doctor', email: email(DOC), doctorId: null });
        await setDoc(doc(db, 'users', DOC2), { role: 'doctor', email: email(DOC2), doctorId: null });
        await setDoc(doc(db, 'users', PAT), { role: 'patient', email: email(PAT), doctorId: DOC, points: 0 });
        await setDoc(doc(db, 'users', PAT2), { role: 'patient', email: email(PAT2), doctorId: null, points: 0 });
        await setDoc(doc(db, 'users', STRANGER), { role: 'patient', email: email(STRANGER), doctorId: null, points: 0 });
        await setDoc(doc(db, 'users', PAT, 'prescriptions', 'rx1'), { doctorId: DOC, patientId: PAT, exerciseId: 'squat', sets: 1, reps: 2, status: 'active' });
        await setDoc(doc(db, 'users', PAT, 'messages', 'm1'), { senderId: DOC, senderRole: 'doctor', text: 'hi' });
    });
});

const { assertSucceeds, assertFails } = await import('@firebase/rules-unit-testing').catch(() => ({}));

const session = (over = {}) => ({ patientId: PAT, prescriptionId: 'rx1', exerciseId: 'squat', status: 'completed', validReps: 2, incompleteReps: 0, reps: [], feedback: null, ...over });

test('patient reads own profile; stranger cannot', { skip }, async () => {
    const { doc, getDoc } = F;
    await assertSucceeds(getDoc(doc(ctx(PAT), 'users', PAT)));
    await assertFails(getDoc(doc(ctx(STRANGER), 'users', PAT)));
});

test('doctor lists only assigned patients', { skip }, async () => {
    const { collection, query, where, getDocs } = F;
    await assertSucceeds(getDocs(query(collection(ctx(DOC), 'users'), where('doctorId', '==', DOC))));
    await assertFails(getDocs(query(collection(ctx(DOC), 'users'), where('role', '==', 'patient'))));
});

test('other doctor cannot read patient sessions or chat', { skip }, async () => {
    const { collection, getDocs } = F;
    await assertSucceeds(getDocs(collection(ctx(DOC), 'users', PAT, 'messages')));
    await assertFails(getDocs(collection(ctx(DOC2), 'users', PAT, 'messages')));
    await assertFails(getDocs(collection(ctx(DOC2), 'users', PAT, 'sessions')));
});

test('patient cannot change own role or self-assign a doctor', { skip }, async () => {
    const { doc, updateDoc } = F;
    await assertFails(updateDoc(doc(ctx(PAT2), 'users', PAT2), { role: 'doctor' }));
    await assertFails(updateDoc(doc(ctx(PAT2), 'users', PAT2), { doctorId: DOC }));
});

test('patient cannot award themselves points', { skip }, async () => {
    const { doc, updateDoc } = F;
    await assertFails(updateDoc(doc(ctx(PAT), 'users', PAT), { points: 1000 }));
    await assertFails(updateDoc(doc(ctx(PAT), 'users', PAT), { points: 10, lastRewardedPrescription: 'rx1' })); // rx not completed in batch
});

test('valid completion batch: session + prescription + exactly 10 points', { skip }, async () => {
    const { doc, writeBatch } = F;
    const db = ctx(PAT);
    const b = writeBatch(db);
    b.set(doc(db, 'users', PAT, 'sessions', 's1'), session());
    b.update(doc(db, 'users', PAT, 'prescriptions', 'rx1'), { status: 'completed', lastSessionId: 's1', completedAt: new Date(), totalRepsCompleted: 2 });
    b.update(doc(db, 'users', PAT), { points: 10, lastRewardedPrescription: 'rx1' });
    await assertSucceeds(b.commit());
});

test('completion rejected when session has too few reps', { skip }, async () => {
    const { doc, writeBatch } = F;
    const db = ctx(PAT);
    const b = writeBatch(db);
    b.set(doc(db, 'users', PAT, 'sessions', 's2'), session({ validReps: 1 }));
    b.update(doc(db, 'users', PAT, 'prescriptions', 'rx1'), { status: 'completed', lastSessionId: 's2', completedAt: new Date(), totalRepsCompleted: 1 });
    await assertFails(b.commit());
});

test('session records cannot be overwritten (duplicate completion)', { skip }, async () => {
    const { doc, setDoc } = F;
    const db = ctx(PAT);
    await assertSucceeds(setDoc(doc(db, 'users', PAT, 'sessions', 's3'), session({ status: 'stopped', prescriptionId: null })));
    await assertFails(setDoc(doc(db, 'users', PAT, 'sessions', 's3'), session({ status: 'stopped', prescriptionId: null, validReps: 99 })));
});

test('only the assigned doctor can prescribe', { skip }, async () => {
    const { doc, setDoc } = F;
    const rx = { doctorId: DOC2, patientId: PAT, exerciseId: 'squat', sets: 3, reps: 10, status: 'active' };
    await assertFails(setDoc(doc(ctx(DOC2), 'users', PAT, 'prescriptions', 'x'), rx));
    await assertSucceeds(setDoc(doc(ctx(DOC), 'users', PAT, 'prescriptions', 'y'), { ...rx, doctorId: DOC }));
    await assertFails(setDoc(doc(ctx(PAT), 'users', PAT, 'prescriptions', 'z'), { ...rx, doctorId: DOC }));
});

test('chat: participants only, sender identity enforced', { skip }, async () => {
    const { doc, setDoc, serverTimestamp } = F;
    const msg = (uid, role) => ({ senderId: uid, senderRole: role, text: 'hello', createdAt: serverTimestamp() });
    await assertSucceeds(setDoc(doc(ctx(PAT), 'users', PAT, 'messages', 'a'), msg(PAT, 'patient')));
    await assertFails(setDoc(doc(ctx(PAT), 'users', PAT, 'messages', 'b'), msg(DOC, 'doctor')));       // spoofing
    await assertFails(setDoc(doc(ctx(STRANGER), 'users', PAT, 'messages', 'c'), msg(STRANGER, 'patient')));
});

test('link request: consent-based relationship', { skip }, async () => {
    const { doc, setDoc, writeBatch } = F;
    await assertSucceeds(setDoc(doc(ctx(DOC2), 'link_requests', 'L1'), { doctorId: DOC2, patientEmail: email(PAT2), status: 'pending' }));
    // a different patient cannot accept someone else's invitation
    const bad = writeBatch(ctx(STRANGER));
    bad.update(doc(ctx(STRANGER), 'link_requests', 'L1'), { status: 'accepted' });
    bad.update(doc(ctx(STRANGER), 'users', STRANGER), { doctorId: DOC2, linkRequestId: 'L1' });
    await assertFails(bad.commit());
    // the invited patient can
    const db = ctx(PAT2);
    const ok = writeBatch(db);
    ok.update(doc(db, 'link_requests', 'L1'), { status: 'accepted', respondedAt: new Date() });
    ok.update(doc(db, 'users', PAT2), { doctorId: DOC2, linkRequestId: 'L1' });
    await assertSucceeds(ok.commit());
});

test('clinical records cannot be deleted', { skip }, async () => {
    const { doc, deleteDoc } = F;
    await assertFails(deleteDoc(doc(ctx(PAT), 'users', PAT, 'prescriptions', 'rx1')));
    await assertFails(deleteDoc(doc(ctx(DOC), 'users', PAT, 'messages', 'm1')));
});
