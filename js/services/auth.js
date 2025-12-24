import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../config.js";

// Initialize core app
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Role checking and redirection
export async function checkAuthAndRedirect(requiredRole = null) {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            // If on a protected page (not login/index/signup), redirect to index
            if (window.location.pathname.includes('dashboard')) {
                window.location.replace('./index.html?err=notLoggedIn');
            }
            return;
        }

        try {
            let userDoc = await getDoc(doc(db, "users", user.uid));

            // Retry logic: If doc doesn't exist, wait and try again (handling race condition)
            if (!userDoc.exists()) {
                console.log("User profile not found immediately. Retrying in 1.5s...");
                await new Promise(resolve => setTimeout(resolve, 1500));
                userDoc = await getDoc(doc(db, "users", user.uid));
            }

            if (userDoc.exists()) {
                const { role } = userDoc.data();
                const normalizedRole = (role || '').toString().trim().toLowerCase();

                // If we are on a dashboard page, verify role
                if (window.location.pathname.includes('doctor-dashboard') && normalizedRole !== 'doctor') {
                    window.location.replace('./patient-dashboard.html');
                } else if (window.location.pathname.includes('patient-dashboard') && normalizedRole !== 'patient') {
                    window.location.replace('./doctor-dashboard.html');
                }

                // If on login/index, redirect to dashboard
                if (window.location.pathname.includes('login') || window.location.pathname.endsWith('/') || window.location.pathname.includes('index')) {
                    if (normalizedRole === 'doctor') window.location.replace('./doctor-dashboard.html');
                    else if (normalizedRole === 'patient') window.location.replace('./patient-dashboard.html');
                }
            } else {
                console.warn("User profile still missing after retry. Check Firestore permissions or creation logic.");
                // Do NOT auto-heal to patient. Let the user stay on the page or show a specific error if appropriate.
                // For now, we simply don't redirect, allowing the script to fail gracefully or the user to retry.
            }
        } catch (error) {
            console.error("Auth check error:", error);
        }
    });

    // Return the listener unsubscribe function if needed, but usually we just let it run
}

export async function login(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
}

export async function logout() {
    return signOut(auth).then(() => window.location.replace('./index.html'));
}

export async function createPatientAccount(email, password, doctorId) {
    // Secondary app workaround for creating a user while logged in
    const secondaryApp = initializeApp(firebaseConfig, "secondary");
    const secondaryAuth = getAuth(secondaryApp);

    try {
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const newPatient = userCredential.user;

        await setDoc(doc(db, "users", newPatient.uid), {
            email: email,
            role: 'patient',
            doctorId: doctorId,
            createdAt: serverTimestamp(),
            points: 0
        });

        await signOut(secondaryAuth);
        await deleteApp(secondaryApp);
        return newPatient;
    } catch (error) {
        console.error("Error creating patient:", error);
        // Ensure secondary app is cleaned up on error
        try {
            await signOut(secondaryAuth);
            await deleteApp(secondaryApp);
        } catch (cleanupError) {
            console.warn("Cleanup error:", cleanupError);
        }
        throw error;
    }
}
