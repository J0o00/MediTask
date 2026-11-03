import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const DASHBOARD = { doctor: './doctor-dashboard.html', patient: './patient-dashboard.html' };

async function fetchProfile(user, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) return { uid: snap.id, ...snap.data() };
        // Sign-up writes the profile right after creating the auth user; give it a moment.
        await new Promise(r => setTimeout(r, 1200));
    }
    return null;
}

/**
 * Resolve once the signed-in user is confirmed to have `role`.
 * Redirects away (and never resolves) otherwise.
 * @returns {Promise<{user: import('firebase/auth').User, profile: object}>}
 */
export function requireRole(role) {
    return new Promise((resolve) => {
        const stop = onAuthStateChanged(auth, async (user) => {
            stop();
            if (!user) { window.location.replace('./index.html?err=notLoggedIn'); return; }
            try {
                const profile = await fetchProfile(user);
                if (!profile) { window.location.replace('./login.html?err=noProfile'); return; }
                const actual = String(profile.role || '').trim().toLowerCase();
                if (actual !== role) { window.location.replace(DASHBOARD[actual] || './index.html'); return; }
                resolve({ user, profile });
            } catch (e) {
                console.error('Auth check failed:', e);
                window.location.replace('./login.html?err=authCheck');
            }
        });
    });
}

/** On public pages (index/login/signup): send signed-in users to their dashboard. */
export function redirectIfSignedIn() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) return;
        try {
            const profile = await fetchProfile(user, 1);
            const role = String(profile?.role || '').toLowerCase();
            if (DASHBOARD[role]) window.location.replace(DASHBOARD[role]);
        } catch (e) { console.warn('Redirect check failed:', e); }
    });
}

/** Back-compat shim for older pages. */
export function checkAuthAndRedirect(requiredRole = null) {
    if (requiredRole) return requireRole(requiredRole);
    return redirectIfSignedIn();
}

export async function login(email, password) {
    return signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function logout() {
    await signOut(auth);
    window.location.replace('./index.html');
}

/** Self sign-up. Profile shape must satisfy the `users` create rule. */
export async function signUp(email, password, role, displayName = '') {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    const profile = {
        uid: cred.user.uid,
        email: cred.user.email.toLowerCase(),
        role,
        displayName: displayName || cred.user.email.split('@')[0],
        createdAt: serverTimestamp(),
        doctorId: null,
        consent: null,
    };
    if (role === 'patient') profile.points = 0;
    await setDoc(doc(db, "users", cred.user.uid), profile);
    return cred.user;
}

/**
 * A doctor creates a patient account that is linked to them from the start.
 * Uses a secondary Firebase app so the doctor stays signed in.
 */
export async function createPatientAccount(email, password, doctorId, displayName = '') {
    const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);
    try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email.trim(), password);
        // Written with the doctor's credentials (primary app) - allowed by the
        // "doctor creates a patient they own" branch of the users create rule.
        await setDoc(doc(db, "users", cred.user.uid), {
            uid: cred.user.uid,
            email: cred.user.email.toLowerCase(),
            role: 'patient',
            displayName: displayName || cred.user.email.split('@')[0],
            doctorId,
            points: 0,
            consent: null,
            createdAt: serverTimestamp(),
        });
        return cred.user;
    } finally {
        try { await signOut(secondaryAuth); await deleteApp(secondaryApp); } catch (e) { /* ignore */ }
    }
}
