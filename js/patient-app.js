import { auth, checkAuthAndRedirect, logout, db } from "./services/auth.js";
import { getPatientPrescriptions, subscribeToChat, sendMessage, logExerciseRep, completeExercise, saveExerciseFeedback, getExerciseStats } from "./services/db.js";
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

// AI Form Accuracy State
let currentAccuracy = 0;
let jointStatuses = {};

// --- Utility: Calculate angle between three points ---
function calculateAngle(a, b, c) {
    // a, b, c are {x, y} points. b is the vertex.
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180.0 / Math.PI);
    if (angle > 180) angle = 360 - angle;
    return angle;
}

// --- Update Accuracy UI ---
function updateAccuracyUI(accuracy, feedback, joints) {
    currentAccuracy = accuracy;
    jointStatuses = joints;

    const ring = document.getElementById('accuracy-ring');
    const percent = document.getElementById('accuracy-percent');
    const feedbackEl = document.getElementById('form-feedback');
    const jointIndicators = document.getElementById('joint-indicators');

    if (!ring || !percent) return;

    // Update circular gauge (circumference = 2 * PI * 45 = ~283)
    const offset = 283 - (283 * accuracy / 100);
    ring.style.strokeDashoffset = offset;

    // Update color based on accuracy
    if (accuracy >= 80) {
        ring.style.stroke = '#22c55e'; // green
        percent.className = 'text-2xl font-bold text-green-400';
    } else if (accuracy >= 50) {
        ring.style.stroke = '#eab308'; // yellow
        percent.className = 'text-2xl font-bold text-yellow-400';
    } else {
        ring.style.stroke = '#ef4444'; // red
        percent.className = 'text-2xl font-bold text-red-400';
    }

    percent.textContent = `${Math.round(accuracy)}%`;
    feedbackEl.textContent = feedback;

    // Update joint indicators
    if (jointIndicators) {
        jointIndicators.innerHTML = '';
        for (const [joint, isCorrect] of Object.entries(joints)) {
            const indicator = document.createElement('span');
            indicator.className = `px-2 py-1 rounded text-xs font-medium ${isCorrect ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`;
            indicator.textContent = `${isCorrect ? '✓' : '✗'} ${joint}`;
            jointIndicators.appendChild(indicator);
        }
    }
}


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
            loadAnalytics(); // Load analytics dashboard
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

    card.querySelector('.start-btn').onclick = () => showExerciseDemo(prescription);
    prescriptionList.appendChild(card);
}

// Exercise demo content
const exerciseDemos = {
    'Right Hand Raise': {
        emoji: '🙋‍♂️',
        title: 'Right Hand Raise',
        steps: [
            '1. Stand straight with arms at your sides',
            '2. Keep your right arm straight',
            '3. Raise your right arm above your head',
            '4. Hold briefly, then lower slowly'
        ]
    },
    'Shoulder Abduction': {
        emoji: '🧍‍♂️',
        title: 'Shoulder Abduction (T-Pose)',
        steps: [
            '1. Stand with arms relaxed at sides',
            '2. Raise both arms out to the sides',
            '3. Stop when arms are at shoulder height',
            '4. Hold the T-pose, then lower'
        ]
    },
    'Squat': {
        emoji: '🏋️',
        title: 'Squat Exercise',
        steps: [
            '1. Stand with feet shoulder-width apart',
            '2. Bend your knees and push hips back',
            '3. Lower until thighs are parallel to floor',
            '4. Push through heels to stand up'
        ]
    }
};

let pendingPrescription = null;

function showExerciseDemo(prescription) {
    pendingPrescription = prescription;

    const demo = exerciseDemos[prescription.exercise] || {
        emoji: '🏃',
        title: prescription.exercise,
        steps: ['Follow the on-screen instructions']
    };

    document.getElementById('demo-title').textContent = demo.title;
    document.getElementById('demo-animation').textContent = demo.emoji;
    document.getElementById('demo-instructions').innerHTML =
        `<ul class="text-left space-y-2">${demo.steps.map(s => `<li class="flex gap-2"><span class="text-teal-400">•</span> ${s}</li>`).join('')}</ul>`;

    document.getElementById('demo-modal').classList.remove('hidden');
}

document.getElementById('start-exercise-btn')?.addEventListener('click', () => {
    document.getElementById('demo-modal').classList.add('hidden');
    if (pendingPrescription) {
        startExercise(pendingPrescription);
    }
});

document.getElementById('cancel-demo-btn')?.addEventListener('click', () => {
    document.getElementById('demo-modal').classList.add('hidden');
    pendingPrescription = null;
});

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
        let analysisResult = { isCorrect: false, accuracy: 0, feedback: '', joints: {} };

        switch (currentPrescription.exercise) {
            case 'Right Hand Raise': analysisResult = analyzeHandRaiseWithAccuracy(landmarks); break;
            case 'Shoulder Abduction': analysisResult = analyzeShoulderAbductionWithAccuracy(landmarks); break;
            case 'Squat': analysisResult = analyzeSquatWithAccuracy(landmarks); break;
        }

        // Update the AI Accuracy UI
        updateAccuracyUI(analysisResult.accuracy, analysisResult.feedback, analysisResult.joints);

        if (analysisResult.isCorrect) {
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
            feedbackBox.textContent = analysisResult.feedback || getInstruction();
        }

        // Draw skeleton with color-coded joints
        drawConnectors(canvasCtx, landmarks, POSE_CONNECTIONS, { color: '#4ade80', lineWidth: 4 });

        // Custom landmark drawing with color based on correctness
        landmarks.forEach((landmark, idx) => {
            if (landmark.visibility > 0.5) {
                const x = landmark.x * canvasElement.width;
                const y = landmark.y * canvasElement.height;
                canvasCtx.beginPath();
                canvasCtx.arc(x, y, 6, 0, 2 * Math.PI);

                // Color key joints based on their status
                let color = '#f87171'; // default red
                if (analysisResult.accuracy >= 80) color = '#22c55e'; // green
                else if (analysisResult.accuracy >= 50) color = '#eab308'; // yellow

                canvasCtx.fillStyle = color;
                canvasCtx.fill();
            }
        });
    } else {
        feedbackBox.textContent = "No person detected.";
        feedbackBox.className = "mt-4 text-center text-xl font-bold p-4 rounded-lg bg-red-800 text-red-200";
        updateAccuracyUI(0, "Position yourself in front of the camera", {});
    }
    canvasCtx.restore();
}

// --- Enhanced Exercise Analysis with Accuracy ---

function analyzeHandRaiseWithAccuracy(landmarks) {
    const rightShoulder = landmarks[12];
    const rightElbow = landmarks[14];
    const rightWrist = landmarks[16];
    const rightHip = landmarks[24];

    const visible = rightShoulder.visibility > 0.5 && rightElbow.visibility > 0.5 && rightWrist.visibility > 0.5;
    if (!visible) return { isCorrect: false, accuracy: 0, feedback: "Can't see your right arm clearly", joints: {} };

    // Calculate arm angle (shoulder-elbow-wrist)
    const armAngle = calculateAngle(rightShoulder, rightElbow, rightWrist);
    const armStraight = armAngle > 150; // Arm should be relatively straight

    // Check if hand is above shoulder
    const handAboveShoulder = rightWrist.y < rightShoulder.y;
    const heightDiff = (rightShoulder.y - rightWrist.y) * 100; // normalized

    // Calculate accuracy
    let accuracy = 0;
    if (handAboveShoulder) {
        accuracy += 50; // Base points for raising hand
        accuracy += Math.min(heightDiff * 2, 30); // Bonus for height
        if (armStraight) accuracy += 20; // Bonus for straight arm
    } else {
        accuracy = Math.max(0, 30 - (rightWrist.y - rightShoulder.y) * 100);
    }
    accuracy = Math.min(100, Math.max(0, accuracy));

    const isCorrect = accuracy >= 80;

    let feedback = '';
    if (accuracy >= 80) feedback = "Excellent form! Hold the position.";
    else if (accuracy >= 50) feedback = "Almost there! Raise your hand higher.";
    else if (!handAboveShoulder) feedback = "⬆️ Raise your right hand above shoulder";
    else if (!armStraight) feedback = "Straighten your arm";
    else feedback = "Keep raising your hand higher";

    return {
        isCorrect,
        accuracy,
        feedback,
        joints: {
            'Shoulder': true,
            'Elbow': armStraight,
            'Wrist': handAboveShoulder
        }
    };
}

function analyzeShoulderAbductionWithAccuracy(landmarks) {
    const leftShoulder = landmarks[11];
    const leftElbow = landmarks[13];
    const leftWrist = landmarks[15];
    const rightShoulder = landmarks[12];
    const rightElbow = landmarks[14];
    const rightWrist = landmarks[16];
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];

    const visible = leftShoulder.visibility > 0.5 && rightShoulder.visibility > 0.5;
    if (!visible) return { isCorrect: false, accuracy: 0, feedback: "Position both shoulders visible", joints: {} };

    // Calculate angles for both arms relative to torso
    const leftArmAngle = calculateAngle(leftHip, leftShoulder, leftElbow);
    const rightArmAngle = calculateAngle(rightHip, rightShoulder, rightElbow);

    // Target: arms at ~90 degrees from body (horizontal)
    const leftScore = Math.max(0, 100 - Math.abs(90 - leftArmAngle));
    const rightScore = Math.max(0, 100 - Math.abs(90 - rightArmAngle));

    const accuracy = (leftScore + rightScore) / 2;
    const isCorrect = accuracy >= 70;

    let feedback = '';
    if (accuracy >= 80) feedback = "Perfect T-pose! Hold it steady.";
    else if (accuracy >= 50) feedback = "Raise both arms to shoulder height";
    else feedback = "Spread arms out to the sides horizontally";

    return {
        isCorrect,
        accuracy,
        feedback,
        joints: {
            'Left Arm': leftScore >= 60,
            'Right Arm': rightScore >= 60
        }
    };
}

function analyzeSquatWithAccuracy(landmarks) {
    const leftHip = landmarks[23];
    const leftKnee = landmarks[25];
    const leftAnkle = landmarks[27];
    const rightHip = landmarks[24];
    const rightKnee = landmarks[26];
    const rightAnkle = landmarks[28];

    const visible = leftKnee.visibility > 0.5 && rightKnee.visibility > 0.5;
    if (!visible) return { isCorrect: false, accuracy: 0, feedback: "Can't see your legs clearly", joints: {} };

    // Calculate knee angles
    const leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
    const rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
    const avgKneeAngle = (leftKneeAngle + rightKneeAngle) / 2;

    // Target: ~90 degrees for a proper squat
    // Score based on how close to 90 degrees
    let accuracy = 0;
    if (avgKneeAngle <= 110) {
        accuracy = Math.max(0, 100 - Math.abs(90 - avgKneeAngle) * 2);
    } else {
        // Standing - encourage going lower
        accuracy = Math.max(0, 50 - (avgKneeAngle - 110));
    }
    accuracy = Math.min(100, Math.max(0, accuracy));

    const isCorrect = accuracy >= 70;

    let feedback = '';
    if (accuracy >= 80) feedback = "Great squat depth! Hold and rise.";
    else if (accuracy >= 50) feedback = "Good start, go a bit lower";
    else if (avgKneeAngle > 150) feedback = "Bend your knees to start the squat";
    else feedback = "Lower your hips more";

    return {
        isCorrect,
        accuracy,
        feedback,
        joints: {
            'Left Knee': leftKneeAngle <= 110,
            'Right Knee': rightKneeAngle <= 110,
            'Depth': avgKneeAngle <= 100
        }
    };
}

function getInstruction() {
    if (currentPrescription.exercise === 'Right Hand Raise') return '⬆️ Raise right hand above shoulder';
    if (currentPrescription.exercise === 'Shoulder Abduction') return '↔️ Spread arms out horizontally';
    if (currentPrescription.exercise === 'Squat') return '⬇️ Bend knees and lower your hips';
    return 'Perform the exercise correctly';
}

async function finishExercise() {
    const points = await completeExercise(auth.currentUser.uid, auth.currentUser.email, currentPrescription.id, currentPrescription.exercise, totalReps, currentPoints);
    updatePointsUI(currentPoints + points);

    // Show the feedback modal instead of immediately redirecting
    showFeedbackModal(points);
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

// --- Post-Exercise Feedback Modal ---
let selectedDifficulty = null;
let pendingPoints = 0;

function showFeedbackModal(points) {
    pendingPoints = points;
    selectedDifficulty = null;

    // Reset modal state
    document.getElementById('pain-slider').value = 1;
    document.getElementById('pain-value').textContent = '1';
    document.getElementById('feedback-notes').value = '';
    document.querySelectorAll('.difficulty-btn').forEach(btn => {
        btn.classList.remove('border-teal-500', 'bg-teal-500/20');
        btn.classList.add('border-gray-700');
    });

    // Show modal
    document.getElementById('feedback-modal').classList.remove('hidden');
}

function closeFeedbackModal() {
    document.getElementById('feedback-modal').classList.add('hidden');
    showRewardNotification(pendingPoints);

    setTimeout(() => {
        showPrescriptionList();
        loadPrescriptions();
    }, 2000);
}

// Pain slider update
document.getElementById('pain-slider')?.addEventListener('input', (e) => {
    document.getElementById('pain-value').textContent = e.target.value;
});

// Difficulty button selection
document.querySelectorAll('.difficulty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove selection from all
        document.querySelectorAll('.difficulty-btn').forEach(b => {
            b.classList.remove('border-teal-500', 'bg-teal-500/20');
            b.classList.add('border-gray-700');
        });
        // Add selection to clicked
        btn.classList.add('border-teal-500', 'bg-teal-500/20');
        btn.classList.remove('border-gray-700');
        selectedDifficulty = btn.dataset.difficulty;
    });
});

// Submit feedback
document.getElementById('submit-feedback-btn')?.addEventListener('click', async () => {
    const painLevel = parseInt(document.getElementById('pain-slider').value);
    const notes = document.getElementById('feedback-notes').value.trim();

    if (!selectedDifficulty) {
        alert('Please select a difficulty level');
        return;
    }

    try {
        await saveExerciseFeedback(
            auth.currentUser.uid,
            auth.currentUser.email,
            currentPrescription.exercise,
            painLevel,
            selectedDifficulty,
            notes
        );
        console.log('Feedback saved successfully');
    } catch (e) {
        console.error('Error saving feedback:', e);
    }

    closeFeedbackModal();
});

// Skip feedback
document.getElementById('skip-feedback-btn')?.addEventListener('click', () => {
    closeFeedbackModal();
});

// --- Analytics Dashboard ---
let weeklyChart = null;

async function loadAnalytics() {
    try {
        const stats = await getExerciseStats(auth.currentUser.uid);

        // Update stat cards
        document.getElementById('stat-total-exercises').textContent = stats.totalExercises || 0;
        document.getElementById('stat-streak').textContent = stats.streak || 0;
        document.getElementById('stat-adherence').textContent = `${stats.adherenceRate || 0}%`;

        // Render weekly chart if Chart.js is available
        const canvas = document.getElementById('weekly-chart');
        if (canvas && typeof Chart !== 'undefined' && stats.weeklyData && stats.weeklyData.length > 0) {
            const ctx = canvas.getContext('2d');

            // Destroy existing chart if any
            if (weeklyChart) weeklyChart.destroy();

            weeklyChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: stats.weeklyData.map(d => d.day),
                    datasets: [{
                        label: 'Exercises Completed',
                        data: stats.weeklyData.map(d => d.count),
                        backgroundColor: 'rgba(20, 184, 166, 0.7)',
                        borderColor: 'rgba(20, 184, 166, 1)',
                        borderWidth: 1,
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                color: '#9ca3af',
                                stepSize: 1
                            },
                            grid: { color: 'rgba(75, 85, 99, 0.3)' }
                        },
                        x: {
                            ticks: { color: '#9ca3af' },
                            grid: { display: false }
                        }
                    }
                }
            });
        }
    } catch (e) {
        console.error("Error loading analytics:", e);
    }
}
