// In-memory Firebase Auth stand-in for browser end-to-end tests.
const F = (window.__FAKE ||= { user: null, docs: {} });
export function getAuth() { return F.auth ||= { get currentUser() { return F.user; } }; }
export function onAuthStateChanged(_a, cb) { setTimeout(() => cb(F.user), 10); return () => {}; }
export async function signOut() { F.user = null; }
export async function signInWithEmailAndPassword(_a, email) { F.user = { uid: email.split('@')[0], email }; return { user: F.user }; }
export async function createUserWithEmailAndPassword(_a, email) { return { user: { uid: 'new-' + email.split('@')[0], email } }; }
