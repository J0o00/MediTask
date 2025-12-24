import { auth, checkAuthAndRedirect, logout, createPatientAccount } from "./services/auth.js";
import { getPatients, getExerciseHistory, subscribeToChat, sendMessage, assignPrescription, linkPatientToDoctor } from "./services/db.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Initialize Auth Guard
checkAuthAndRedirect('doctor');

// DOM Elements
const mainContent = document.getElementById('main-content');
const loadingView = document.getElementById('loading-view');
const reportView = document.getElementById('report-view');
const prescriptionView = document.getElementById('prescription-view');
const prescriptionForm = document.getElementById('prescription-form');
const patientListDiv = document.getElementById('patient-list');
const reportContainer = document.getElementById('patient-report');
// Chat Elements
const chatModal = document.getElementById('chat-modal');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatPatientName = document.getElementById('chat-patient-name');
let currentChatPatientId = null;
let currentChatUnsubscribe = null;

let selectedPatient = null;

// --- Initialization ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        // We rely on checkAuthAndRedirect to handle potential role mismatches
        // But we need to show UI once confirmed
        loadingView.classList.add('hidden');
        mainContent.classList.remove('hidden');
        initDoctorView();
    }
});

document.getElementById('logout-btn').addEventListener('click', () => logout());

async function initDoctorView() {
    // Load patients
    try {
        const patients = await getPatients();
        renderPatientList(patients);
    } catch (e) {
        console.error("Error loading patients:", e);
    }
}

function renderPatientList(patients) {
    patientListDiv.innerHTML = '';
    if (patients.length === 0) {
        patientListDiv.innerHTML = '<p class="text-gray-400 p-3">No patients found.</p>';
        return;
    }
    patients.forEach(patient => {
        const div = document.createElement('div');
        div.className = 'p-3 bg-gray-900 rounded-lg cursor-pointer hover:bg-teal-700 transition-colors flex justify-between items-center';
        div.innerHTML = `
            <span>${patient.email}</span>
            <button class="chat-btn-quick bg-teal-500 text-black text-xs px-2 py-1 rounded font-bold ml-2">Chat</button>
        `;

        // Click on div -> Select Patient
        div.onclick = (e) => {
            // If clicked specifically on chat button, open chat directly
            if (e.target.classList.contains('chat-btn-quick')) {
                e.stopPropagation();
                openChat(patient.uid, patient.email);
            } else {
                document.querySelectorAll('#patient-list > div').forEach(el => el.classList.remove('bg-teal-600'));
                div.classList.add('bg-teal-600');
                selectedPatient = patient;
                loadPatientReport(patient.uid, patient.email);
            }
        };
        patientListDiv.appendChild(div);
    });
}

function selectPatient(element, patient) {
    document.querySelectorAll('#patient-list > div').forEach(el => el.classList.remove('bg-teal-600'));
    element.classList.add('bg-teal-600');
    selectedPatient = patient;
    loadPatientReport(patient.uid, patient.email);
}

async function loadPatientReport(patientId, patientEmail) {
    prescriptionView.classList.add('hidden');
    reportView.classList.remove('hidden');
    document.getElementById('report-placeholder').classList.add('hidden');
    reportContainer.classList.remove('hidden');
    reportContainer.innerHTML = `<div class="loader mx-auto"></div>`;

    const logs = await getExerciseHistory(patientId);
    const feedbackLogs = logs.filter(l => l.type === 'feedback');

    let reportHTML = `
        <div class="flex justify-between items-center mb-6">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-lg">
                    ${patientEmail[0].toUpperCase()}
                </div>
                <div>
                     <h4 class="font-bold text-lg text-slate-800">${patientEmail}</h4>
                     <p class="text-xs text-slate-500">Patient ID: ${patientId.slice(0, 8)}...</p>
                </div>
            </div>
            <div class="flex gap-2 flex-wrap">
                <button id="export-pdf-btn" class="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-2 px-4 rounded-lg text-sm shadow-md transition-all">
                    📄 Export PDF
                </button>
                <button id="open-chat-btn" class="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold py-2 px-4 rounded-lg text-sm shadow-sm transition-all">
                    Message
                </button>
                <button id="show-prescription-form-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg text-sm shadow-md shadow-blue-600/20 transition-all">
                    Assign Exercise
                </button>
            </div>
        </div>`;

    if (logs.length === 0) {
        reportHTML += `
            <div class="text-center py-10 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                <p class="text-slate-400">No exercise history found for this patient.</p>
            </div>`;
    } else {
        logs.forEach(log => {
            const date = log.timestamp ? log.timestamp.toDate().toLocaleString() : 'No date';
            const isSuccess = log.isCorrect;
            const statusColor = isSuccess ? 'bg-green-50 text-green-700 border-green-100' : 'bg-yellow-50 text-yellow-700 border-yellow-100';
            const icon = isSuccess ? '✅' : '⚠️';

            reportHTML += `
                <div class="p-4 bg-white rounded-xl border border-slate-100 shadow-sm mb-3 flex justify-between items-center hover:shadow-md transition-shadow">
                    <div>
                        <p class="font-bold text-slate-800 text-sm">${log.exercise || 'Unknown Exercise'}</p>
                        <p class="text-xs text-slate-400 mt-1">${date}</p>
                    </div>
                    <div class="px-3 py-1.5 rounded-lg border text-sm font-medium ${statusColor} flex items-center gap-2">
                        <span>${icon}</span>
                        ${log.feedback}
                    </div>
                </div>`;
        });
    }

    reportContainer.innerHTML = reportHTML;

    // Bind dynamic buttons
    document.getElementById('show-prescription-form-btn').onclick = () => {
        reportView.classList.add('hidden');
        prescriptionView.classList.remove('hidden');
    };
    document.getElementById('open-chat-btn').onclick = () => {
        openChat(patientId, patientEmail);
    };
    document.getElementById('export-pdf-btn').onclick = () => {
        if (typeof window.exportPatientPDF === 'function') {
            window.exportPatientPDF(patientEmail, logs, feedbackLogs);
        } else {
            alert('PDF export is loading, please try again.');
        }
    };
}

// --- Prescription Logic ---
prescriptionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedPatient) return;

    const exercise = document.getElementById('exercise-select').value;
    const sets = parseInt(document.getElementById('sets-input').value);
    const reps = parseInt(document.getElementById('reps-input').value);

    try {
        await assignPrescription(auth.currentUser.uid, selectedPatient.uid, selectedPatient.email, exercise, sets, reps);
        alert(`Exercise assigned to ${selectedPatient.email}`);
        prescriptionView.classList.add('hidden');
        reportView.classList.remove('hidden');
    } catch (error) {
        console.error("Error assigning prescription:", error);
        alert("Failed to assign exercise.");
    }
});

document.getElementById('cancel-prescription-btn').addEventListener('click', () => {
    prescriptionView.classList.add('hidden');
    reportView.classList.remove('hidden');
});

// --- Chat Logic ---
function openChat(patientId, patientEmail) {
    currentChatPatientId = patientId;
    chatPatientName.textContent = patientEmail;
    chatModal.classList.remove('hidden');

    if (currentChatUnsubscribe) currentChatUnsubscribe();

    currentChatUnsubscribe = subscribeToChat(patientId, (messages) => {
        chatMessages.innerHTML = '';
        messages.forEach(msg => {
            const isMe = msg.senderId === auth.currentUser.uid;
            const div = document.createElement('div');
            div.className = `flex ${isMe ? 'justify-end' : 'justify-start'}`;
            div.innerHTML = `
                <div class="max-w-[80%] rounded-lg px-3 py-2 ${isMe ? 'bg-teal-600 text-white' : 'bg-gray-700 text-gray-200'}">
                    <p class="text-xs font-bold mb-1 text-gray-300">${msg.senderName || 'User'}</p>
                    <p class="text-sm">${msg.text}</p>
                </div>
            `;
            chatMessages.appendChild(div);
        });
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

document.getElementById('close-chat-btn').addEventListener('click', () => {
    chatModal.classList.add('hidden');
    if (currentChatUnsubscribe) currentChatUnsubscribe();
    currentChatUnsubscribe = null;
});

document.getElementById('send-msg-btn').addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentChatPatientId) return;

    try {
        await sendMessage(auth.currentUser.uid, 'Doctor', text, 'doctor_msg', currentChatPatientId);
        chatInput.value = '';
    } catch (e) {
        console.error("Send error:", e);
    }
}

// --- Add Patient Logic ---
const addPatientBtn = document.getElementById('add-patient-btn');
const addPatientModal = document.getElementById('add-patient-modal');
const cancelAddPatientBtn = document.getElementById('cancel-add-patient-btn');
const addPatientForm = document.getElementById('add-patient-form');
const addPatientError = document.getElementById('add-patient-error');
const submitAddPatientBtn = document.getElementById('submit-add-patient-btn');

addPatientBtn.addEventListener('click', () => {
    addPatientModal.classList.remove('hidden');
    addPatientForm.reset();
    addPatientError.textContent = '';
    addPatientError.classList.add('hidden');
});

cancelAddPatientBtn.addEventListener('click', () => addPatientModal.classList.add('hidden'));

addPatientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('new-patient-email').value;
    const password = document.getElementById('new-patient-password').value;

    submitAddPatientBtn.disabled = true;
    submitAddPatientBtn.textContent = 'Creating...';

    try {
        await createPatientAccount(email, password, auth.currentUser.uid);
        alert('Patient created successfully!');
        addPatientModal.classList.add('hidden');
        initDoctorView(); // Refresh list
    } catch (error) {
        console.error("Add patient error:", error);
        addPatientError.textContent = "Error: " + error.message;
        addPatientError.classList.remove('hidden');
    } finally {
        submitAddPatientBtn.disabled = false;
        submitAddPatientBtn.textContent = 'Create Patient';
    }
});
