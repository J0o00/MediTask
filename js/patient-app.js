import { auth, checkAuthAndRedirect, logout, db } from "./services/auth.js";
import { getPatientPrescriptions, subscribeToChat, sendMessage, logExerciseRep, completeExercise } from "./services/db.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// db imported from services/auth.js

// Initialize Auth Guard
checkAuthAndRedirect('patient');

// DOM Elements
const mainContent = document.getElementById('main-content');
const loadingView = document.getElementById('loading-view');
const prescriptionListView = document.getElementById('prescription-list-view');
const exerciseSessionView = document.getElementById('exercise-session-view');
const prescriptionList = document.getElementById('prescription-list');
const prescriptionLoadingDiv = document.getElementById('prescription-loading');
// Exercise UI
const progressBar = document.getElementById('progress-bar');
const feedbackBox = document.getElementById('feedback-box');
// Chat UI
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const chatModal = document.getElementById('chat-modal');
const closeChatBtn = document.getElementById('close-chat-btn');
const chatInput = document.getElementById('chat-input');
const sendMsgBtn = document.getElementById('send-msg-btn');
const chatMessages = document.getElementById('chat-messages');

// State
let video, canvasCtx, canvasElement, pose, cameraInstance;
let isCameraActive = false;
let currentPrescription = null;
let currentSet = 1;
let currentReps = 0;
let totalReps = 0;
let lastRepTime = 0;
let repThreshold = 1000;
let currentPoints = 0;
let chatUnsubscribe = null;

// --- Initialization ---

onAuthStateChanged(auth, async (user) => {
    if (user) {
        try {
            loadingView.classList.add('hidden');
            mainContent.classList.remove('hidden');

            // Load points
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists()) {
                updatePointsUI(userDoc.data().points || 0);
            }
            document.getElementById('rewards-card').classList.remove('hidden');

            await loadPrescriptions();
        } catch (error) {
            console.error("Init error:", error);
            loadingView.innerHTML = `<p class="text-red-500">Error loading dashboard: ${error.message}</p>`;
            loadingView.classList.remove('hidden');
        }
    }
});

document.getElementById('logout-btn').addEventListener('click', () => {
    cleanupPatientView();
    logout();
});

document.getElementById('back-to-prescriptions').addEventListener('click', showPrescriptionList);

async function loadPrescriptions() {
    prescriptionList.innerHTML = '';
    prescriptionLoadingDiv.textContent = 'Loading...';

    const userId = auth.currentUser.uid;
    let items = [];
    try {
        items = await getPatientPrescriptions(userId);
    } catch (err) {
        console.error("Prescription load error:", err);
        prescriptionLoadingDiv.innerHTML = `<span class="text-red-400">Failed to load: ${err.message}</span>`;
        if (err.message.includes('index')) {
            prescriptionLoadingDiv.innerHTML += `<br><span class="text-xs text-gray-400">Database index required. Check console for link.</span>`;
        }
        return;
    }

    if (items.length > 0) {
        items.forEach(createPrescriptionCard);
        prescriptionLoadingDiv.textContent = `${items.length} prescription(s) found`;
    } else {
        // Sample fallback
        const samples = [
            { id: 'sample1', exercise: 'Right Hand Raise', sets: 3, reps: 10, assignedAt: new Date() },
            { id: 'sample2', exercise: 'Shoulder Abduction', sets: 2, reps: 15, assignedAt: new Date() },
            { id: 'sample3', exercise: 'Squat', sets: 3, reps: 12, assignedAt: new Date() }
        ];
        samples.forEach(createPrescriptionCard);
        prescriptionLoadingDiv.textContent = 'Showing sample prescriptions';
    }
}

function createPrescriptionCard(prescription) {
    const card = document.createElement('div');
    card.className = 'bg-gray-700 p-4 rounded-xl border border-gray-600 hover:border-teal-500 transition-colors';

    // Convert timestamp
    let dateStr = 'Recently';
    if (prescription.assignedAt && prescription.assignedAt.toDate) {
        dateStr = prescription.assignedAt.toDate().toLocaleDateString();
    } else if (prescription.assignedAt instanceof Date) {
        dateStr = prescription.assignedAt.toLocaleDateString();
    }

    card.innerHTML = `
        <div class="flex justify-between items-start">
            <div>
                <h4 class="font-semibold text-lg">${prescription.exercise}</h4>
                <p class="text-gray-400">${prescription.sets} sets × ${prescription.reps} reps</p>
                <p class="text-sm text-gray-500">Assigned: ${dateStr}</p>
            </div>
            <button class="start-btn bg-teal-500 hover:bg-teal-600 text-black font-bold py-2 px-4 rounded-lg">
                Start
            </button>
        </div>
    `;

    card.querySelector('.start-btn').onclick = () => startExercise(prescription);
    prescriptionList.appendChild(card);
}

function startExercise(prescription) {
    if (!prescription) return;

    currentPrescription = prescription;
    currentSet = 1;
    currentReps = 0;
    totalReps = 0;

    // Update UI
    document.getElementById('exercise-name').textContent = prescription.exercise;
    document.getElementById('exercise-sets').textContent = prescription.sets;
    document.getElementById('exercise-reps').textContent = prescription.reps;
    document.getElementById('total-sets').textContent = prescription.sets;
    document.getElementById('target-reps').textContent = prescription.reps;
    document.getElementById('current-set').textContent = currentSet;
    document.getElementById('current-reps').textContent = currentReps;
    document.getElementById('current-exercise-title').textContent = `${prescription.exercise} - Set ${currentSet}`;

    updateProgressUI();

    prescriptionListView.classList.add('hidden');
    exerciseSessionView.classList.remove('hidden');

    initCamera();
}

function showPrescriptionList() {
    exerciseSessionView.classList.add('hidden');
    prescriptionListView.classList.remove('hidden');
    cleanupPatientView();
}

function updateProgressUI() {
    if (!currentPrescription) return;
    const totalTargetReps = currentPrescription.sets * currentPrescription.reps;
    const completedReps = (currentSet - 1) * currentPrescription.reps + currentReps;
    const progress = Math.min((completedReps / totalTargetReps) * 100, 100);
    progressBar.style.width = `${progress}%`;
}

async function initCamera() {
    if (isCameraActive) return;
    isCameraActive = true;
    video = document.getElementById('webcam');
    canvasElement = document.getElementById('pose-canvas');
    canvasCtx = canvasElement.getContext('2d');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' } });
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
            pose = new Pose({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
            pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
            pose.onResults(onPoseResults);
            cameraInstance = new Camera(video, {
                onFrame: async () => { if (video.readyState >= 3) await pose.send({ image: video }); },
                width: 1280, height: 720
            });
            cameraInstance.start();
        };
    } catch (err) {
        feedbackBox.textContent = `Error: ${err.message}`;
    }
}

function cleanupPatientView() {
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
    if (cameraInstance) { cameraInstance.stop(); cameraInstance = null; }
    if (pose) { pose.close(); pose = null; }
    isCameraActive = false;
}

// --- Pose Analysis ---
async function onPoseResults(results) {
    if (!isCameraActive || !currentPrescription || !canvasCtx || !canvasElement) return;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.poseLandmarks && results.poseLandmarks.length > 0) {
        const landmarks = results.poseLandmarks;
        let isCorrect = false;

        switch (currentPrescription.exercise) {
            case 'Right Hand Raise': isCorrect = analyzeHandRaise(landmarks); break;
            case 'Shoulder Abduction': isCorrect = analyzeShoulderAbduction(landmarks); break;
            case 'Squat': isCorrect = analyzeSquat(landmarks); break;
        }

        if (isCorrect) {
            const now = Date.now();
            if (now - lastRepTime > repThreshold) {
                currentReps++;
                totalReps++;
                lastRepTime = now;

                if (currentReps >= currentPrescription.reps) {
                    currentSet++;
                    currentReps = 0;
                    if (currentSet > currentPrescription.sets) {
                        feedbackBox.className = "mt-4 text-center text-xl font-bold p-4 rounded-lg bg-green-800 text-green-200";
                        feedbackBox.textContent = "🎉 Exercise completed!";
                        finishExercise();
                    } else {
                        feedbackBox.textContent = `✅ Set ${currentSet - 1} completed! Start set ${currentSet}`;
                        document.getElementById('current-set').textContent = currentSet;
                        document.getElementById('current-exercise-title').textContent = `${currentPrescription.exercise} - Set ${currentSet}`;
                    }
                } else {
                    feedbackBox.className = "mt-4 text-center text-xl font-bold p-4 rounded-lg bg-green-800 text-green-200";
                    feedbackBox.textContent = `✅ Rep ${currentReps}/${currentPrescription.reps}`;
                }

                document.getElementById('current-reps').textContent = currentReps;
                updateProgressUI();
                logExerciseRep(auth.currentUser.uid, auth.currentUser.email, currentPrescription.exercise, currentReps, currentSet, totalReps);
            }
        } else {
            feedbackBox.className = "mt-4 text-center text-xl font-bold p-4 rounded-lg bg-yellow-800 text-yellow-200";
            feedbackBox.textContent = getInstruction();
        }

        drawConnectors(canvasCtx, landmarks, POSE_CONNECTIONS, { color: '#4ade80', lineWidth: 4 });
        drawLandmarks(canvasCtx, landmarks, { color: '#f87171', lineWidth: 2, radius: 5 });
    } else {
        feedbackBox.textContent = "No person detected.";
        feedbackBox.className = "mt-4 text-center text-xl font-bold p-4 rounded-lg bg-red-800 text-red-200";
    }
    canvasCtx.restore();
}

function analyzeHandRaise(landmarks) {
    const rightShoulder = landmarks[12];
    const rightWrist = landmarks[16];
    return rightShoulder.visibility > 0.5 && rightWrist.visibility > 0.5 && rightWrist.y < rightShoulder.y;
}

function analyzeShoulderAbduction(landmarks) {
    return landmarks[11].y > landmarks[15].y && landmarks[12].y > landmarks[16].y; // approx check
}

function analyzeSquat(landmarks) {
    return landmarks[25].y > landmarks[23].y + 0.1; // knee below hip roughly
}

function getInstruction() {
    if (currentPrescription.exercise === 'Right Hand Raise') return '⬆️ Raise right hand';
    return 'Perform exercise';
}

async function finishExercise() {
    const points = await completeExercise(auth.currentUser.uid, auth.currentUser.email, currentPrescription.id, currentPrescription.exercise, totalReps, currentPoints);
    updatePointsUI(currentPoints + points);
    showRewardNotification(points);
    setTimeout(() => {
        showPrescriptionList();
        loadPrescriptions();
    }, 3000);
}

function updatePointsUI(points) {
    currentPoints = points;
    document.getElementById('user-points').textContent = points;
    document.getElementById('user-currency').textContent = `₹${(points / 100).toFixed(2)}`;
}

function showRewardNotification(points) {
    const notif = document.createElement('div');
    notif.className = 'fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-yellow-500 text-black font-bold p-6 rounded-2xl shadow-2xl z-50 animate-bounce text-center';
    notif.innerHTML = `<div class="text-4xl mb-2">🎉</div><div class="text-2xl">Exercise Complete!</div><div class="text-xl">+${points} Points</div>`;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
}

// --- Chat ---
chatToggleBtn.addEventListener('click', () => {
    chatModal.classList.toggle('hidden');
    if (!chatModal.classList.contains('hidden')) {
        loadChatMessages();
    }
});
closeChatBtn.addEventListener('click', () => chatModal.classList.add('hidden'));
sendMsgBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    try {
        const user = auth.currentUser;
        if (!user) {
            alert("You must be logged in to send messages.");
            return;
        }
        console.log("Sending chat:", text, user.uid);
        await sendMessage(user.uid, user.email.split('@')[0], text, 'patient_msg', user.uid);
        chatInput.value = '';
    } catch (e) {
        console.error("Chat Error:", e);
        alert("Failed to send message: " + e.message);
    }
}

function loadChatMessages() {
    if (chatUnsubscribe) return;
    chatUnsubscribe = subscribeToChat(auth.currentUser.uid, (messages) => {
        chatMessages.innerHTML = '';
        messages.forEach(msg => {
            const isMe = msg.senderId === auth.currentUser.uid;
            const div = document.createElement('div');
            div.className = `flex ${isMe ? 'justify-end' : 'justify-start'}`;
            div.innerHTML = `
                <div class="max-w-[80%] rounded-lg px-3 py-2 ${isMe ? 'bg-teal-600 text-white' : 'bg-gray-700 text-gray-200'}">
                    <p class="text-sm">${msg.text}</p>
                </div>`;
            chatMessages.appendChild(div);
        });
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}
