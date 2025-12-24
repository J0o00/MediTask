import { db } from "./auth.js";
import { collection, query, where, getDocs, orderBy, addDoc, serverTimestamp, onSnapshot, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firestore collections
const USERS = "users";
const PRESCRIPTIONS = "prescriptions";
const EXERCISE_LOGS = "exercise_logs";
const MESSAGES = "messages";

// --- Doctor Helper Functions ---

export async function getPatients() {
    const q = query(collection(db, USERS), where("role", "==", "patient"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
}

export async function linkPatientToDoctor(patientEmail, doctorId) {
    const q = query(collection(db, USERS), where("email", "==", patientEmail), where("role", "==", "patient"));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
        throw new Error("Patient not found with that email.");
    }

    const patientDoc = snapshot.docs[0];
    const patientData = patientDoc.data();

    // Check if already linked to another doctor (optional policy, here we overwrite or check)
    if (patientData.doctorId && patientData.doctorId !== doctorId) {
        // Optional: throw new Error("Patient is already linked to another doctor.");
    }

    await updateDoc(doc(db, USERS, patientDoc.id), {
        doctorId: doctorId
    });

    return { uid: patientDoc.id, ...patientData };
}

export function subscribeToChat(patientId, callback) {
    const q = query(collection(db, MESSAGES), orderBy("timestamp", "asc"));
    return onSnapshot(q, (snapshot) => {
        const messages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Client-side filter for now
            if (data.patientId === patientId) {
                messages.push({ id: doc.id, ...data });
            }
        });
        callback(messages);
    });
}

export async function sendMessage(senderId, senderName, text, type, patientId) {
    return addDoc(collection(db, MESSAGES), {
        senderId,
        senderName,
        text,
        timestamp: serverTimestamp(),
        type,
        patientId
    });
}

export async function getExerciseHistory(patientId) {
    try {
        const q = query(collection(db, EXERCISE_LOGS), where("patientId", "==", patientId), orderBy("timestamp", "desc"));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) {
        console.error("Error fetching history:", e);
        return [];
    }
}

export async function assignPrescription(doctorId, patientId, patientEmail, exercise, sets, reps) {
    return addDoc(collection(db, PRESCRIPTIONS), {
        doctorId,
        patientId,
        patientEmail,
        exercise,
        sets,
        reps,
        isCompleted: false,
        assignedAt: serverTimestamp()
    });
}

// Get exercise statistics for analytics dashboard
export async function getExerciseStats(patientId) {
    try {
        // Get all completed exercises
        const logsQuery = query(
            collection(db, EXERCISE_LOGS),
            where("patientId", "==", patientId),
            where("completed", "==", true),
            orderBy("timestamp", "desc")
        );
        const logsSnapshot = await getDocs(logsQuery);
        const completedLogs = logsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Get all prescriptions (for adherence calculation)
        const prescQuery = query(
            collection(db, PRESCRIPTIONS),
            where("patientId", "==", patientId)
        );
        const prescSnapshot = await getDocs(prescQuery);
        const totalPrescriptions = prescSnapshot.docs.length;
        const completedPrescriptions = prescSnapshot.docs.filter(d => d.data().isCompleted).length;

        // Calculate adherence rate
        const adherenceRate = totalPrescriptions > 0
            ? Math.round((completedPrescriptions / totalPrescriptions) * 100)
            : 0;

        // Calculate streak (simplified - based on consecutive days with activity)
        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (let i = 0; i < 30; i++) {
            const checkDate = new Date(today);
            checkDate.setDate(checkDate.getDate() - i);
            const hasActivity = completedLogs.some(log => {
                if (log.timestamp && log.timestamp.toDate) {
                    const logDate = log.timestamp.toDate();
                    logDate.setHours(0, 0, 0, 0);
                    return logDate.getTime() === checkDate.getTime();
                }
                return false;
            });
            if (hasActivity) streak++;
            else if (i > 0) break; // Break streak if not today
        }

        // Weekly data for chart
        const weeklyData = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            const count = completedLogs.filter(log => {
                if (log.timestamp && log.timestamp.toDate) {
                    const logDate = log.timestamp.toDate();
                    logDate.setHours(0, 0, 0, 0);
                    return logDate.getTime() === date.getTime();
                }
                return false;
            }).length;
            weeklyData.push({
                day: date.toLocaleDateString('en', { weekday: 'short' }),
                count
            });
        }

        return {
            totalExercises: completedLogs.length,
            streak,
            adherenceRate,
            weeklyData
        };
    } catch (e) {
        console.error("Error getting stats:", e);
        return { totalExercises: 0, streak: 0, adherenceRate: 0, weeklyData: [] };
    }
}

// --- Patient Helper Functions ---

export async function getPatientPrescriptions(patientId) {
    const q = query(collection(db, PRESCRIPTIONS),
        where("patientId", "==", patientId),
        where("isCompleted", "==", false)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function logExerciseRep(patientId, patientEmail, exercise, currentReps, currentSet, totalReps) {
    return addDoc(collection(db, EXERCISE_LOGS), {
        patientId,
        patientEmail,
        exercise,
        feedback: `Rep ${currentReps} - Set ${currentSet}`,
        isCorrect: true,
        repCount: currentReps,
        setCount: currentSet,
        totalReps: totalReps,
        timestamp: serverTimestamp()
    });
}

export async function completeExercise(patientId, patientEmail, prescriptionId, exercise, totalReps, currentPoints) {
    // Log completion
    await addDoc(collection(db, EXERCISE_LOGS), {
        patientId,
        patientEmail,
        exercise,
        feedback: `Exercise completed! Total reps: ${totalReps}`,
        isCorrect: true,
        completed: true,
        timestamp: serverTimestamp()
    });

    // Mark prescription done
    if (prescriptionId && !prescriptionId.startsWith('sample')) {
        await updateDoc(doc(db, PRESCRIPTIONS, prescriptionId), {
            isCompleted: true,
            completedAt: serverTimestamp(),
            totalRepsCompleted: totalReps
        });
    }

    // Award points
    const pointsEarned = 10;
    await updateDoc(doc(db, USERS, patientId), {
        points: currentPoints + pointsEarned
    });
    return pointsEarned;
}

// Save patient's post-exercise feedback (pain/difficulty)
export async function saveExerciseFeedback(patientId, patientEmail, exercise, painLevel, difficulty, notes) {
    return addDoc(collection(db, EXERCISE_LOGS), {
        patientId,
        patientEmail,
        exercise,
        type: 'feedback',
        painLevel: painLevel,
        difficulty: difficulty,
        notes: notes || '',
        timestamp: serverTimestamp()
    });
}
