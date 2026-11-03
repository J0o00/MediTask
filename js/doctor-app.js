// MediTask Clinical - Physiotherapist Dashboard Controller (Lumis Aesthetic)
import { requireRole, logout, createPatientAccount } from "./services/auth.js";
import {
    getMyPatients, unlinkPatient, createLinkRequest, getDoctorPendingLinks, cancelLinkRequest,
    assignPrescription, updatePrescription, getPrescriptions, getSessions, addSessionReview,
    getOpenAlerts, acknowledgeAlert, subscribeToChat, sendMessage,
} from "./services/db.js";
import { EXERCISES, resolveExercise } from "./rehabilitation/exercise-configs.js";
import { buildTwin } from "./digital-twin/progress-model.js";
import { lineChart, SERIES } from "./ui/charts.js";
import { exportPatientReport } from "./ui/report-generator.js";
import { $, el, show, toast, fmtDate, fmtDateTime, renderChat, initials, METRIC_LABEL } from "./ui/dom.js";

let user, profile;
let patients = [];
let alertsByPatient = {};
let selected = null;
let chatUnsub = null;
let isDemoMode = false;

// Mock Demo Data for Clinician Preview if not signed in or demo requested
const DEMO_PATIENTS = [
    {
        uid: "demo-pt-1",
        displayName: "Aarav Q.",
        email: "aq@gmail.com",
        injury: "ACL Rehab Wk 4",
        statusText: "On Track",
        statusKind: "green",
        accuracy: 92,
        accuracyDelta: "+4.2%",
        exercisesCompleted: 5,
        exercisesTotal: 6,
        romDegrees: 124,
        romTarget: 130,
        romJoint: "Knee Extension",
        points: 40,
        sessions: [
            { id: "s1", exercise: "Knee Extension", exerciseId: "squat", startedAt: new Date(Date.now() - 3600000), validReps: 15, targetSets: 3, targetReps: 5, summary: { avgQuality: 92, consistency: 88, lowConfidencePct: 2, rom: { knee: { bestRange: 124 } } } },
            { id: "s2", exercise: "Knee Extension", exerciseId: "squat", startedAt: new Date(Date.now() - 86400000), validReps: 14, targetSets: 3, targetReps: 5, summary: { avgQuality: 89, consistency: 85, lowConfidencePct: 4, rom: { knee: { bestRange: 118 } } } },
            { id: "s3", exercise: "Knee Extension", exerciseId: "squat", startedAt: new Date(Date.now() - 172800000), validReps: 15, targetSets: 3, targetReps: 5, summary: { avgQuality: 87, consistency: 82, lowConfidencePct: 3, rom: { knee: { bestRange: 112 } } } }
        ],
        prescriptions: [
            { id: "rx1", exercise: "Knee Extension (Squat)", exerciseId: "squat", sets: 3, reps: 10, notes: "Perform slowly, keep heel on ground.", assignedAt: new Date(Date.now() - 259200000) }
        ],
        chat: [
            { id: "m1", senderName: "Aarav Q.", senderRole: "patient", text: "Dr. Reynolds, the knee extension feels much smoother today. No sharp pain.", createdAt: new Date(Date.now() - 7200000) },
            { id: "m2", senderName: "Dr. R. Reynolds, MD", senderRole: "doctor", text: "Great news Aarav! Keep up the daily sets.", createdAt: new Date(Date.now() - 3600000) }
        ]
    },
    {
        uid: "demo-pt-2",
        displayName: "Sonia Miller",
        email: "sm@gmail.com",
        injury: "Rotator Cuff • Session 14",
        statusText: "Review Angle (76°)",
        statusKind: "amber",
        accuracy: 78,
        accuracyDelta: "-2.1%",
        exercisesCompleted: 3,
        exercisesTotal: 5,
        romDegrees: 76,
        romTarget: 90,
        romJoint: "Shoulder Abduction",
        points: 20,
        sessions: [
            { id: "s20", exercise: "Shoulder Abduction", exerciseId: "shoulder_abduction", startedAt: new Date(Date.now() - 7200000), validReps: 8, targetSets: 2, targetReps: 5, summary: { avgQuality: 78, consistency: 74, lowConfidencePct: 5, rom: { shoulder: { bestRange: 76 } } } }
        ],
        prescriptions: [
            { id: "rx2", exercise: "Shoulder Abduction", exerciseId: "shoulder_abduction", sets: 2, reps: 8, notes: "Avoid shrugging the trapezius.", assignedAt: new Date(Date.now() - 86400000) }
        ],
        chat: []
    },
    {
        uid: "demo-pt-3",
        displayName: "Kenji Liam",
        email: "kl@gmail.com",
        injury: "Lumbar Spine • Session 28",
        statusText: "Completed (6/6)",
        statusKind: "green",
        accuracy: 96,
        accuracyDelta: "+1.5%",
        exercisesCompleted: 6,
        exercisesTotal: 6,
        romDegrees: 110,
        romTarget: 115,
        romJoint: "Lateral Leg Raise",
        points: 60,
        sessions: [],
        prescriptions: [],
        chat: []
    }
];

const DEMO_PENDING_LINKS = [
    { id: "link-1", patientEmail: "elena.rostova@example.com", status: "pending" }
];

// Boot sequence
(async function init() {
    try {
        const authResult = await requireRole("doctor").catch(() => null);
        if (authResult && authResult.user) {
            user = authResult.user;
            profile = authResult.profile;
        } else {
            activateDemoMode();
        }
    } catch {
        activateDemoMode();
    }

    if (profile) {
        const name = profile.displayName || profile.email?.split("@")[0] || "Dr. R. Reynolds, MD";
        if ($("doctor-line")) $("doctor-line").textContent = name;
        if ($("doctor-avatar")) $("doctor-avatar").textContent = initials(name);
    }

    populateExerciseSelect();
    setupNavigation();
    setupModals();
    await refreshPatients();
})();

function activateDemoMode() {
    isDemoMode = true;
    user = { uid: "demo-doctor-id", email: "dr.reynolds@meditask.health" };
    profile = { uid: "demo-doctor-id", email: "dr.reynolds@meditask.health", role: "doctor", displayName: "Dr. R. Reynolds, MD" };
    show("demo-banner", true);
}

// ------------------------------------------------------------------ Exercise Select
function populateExerciseSelect() {
    const sel = $("exercise-select");
    if (!sel) return;
    sel.replaceChildren(...Object.values(EXERCISES).map(e => el("option", { value: e.id }, e.name)));
    const desc = () => {
        const e = EXERCISES[sel.value];
        if ($("exercise-desc")) {
            $("exercise-desc").textContent = e ? `Target ${e.targetValue}° at the ${(METRIC_LABEL[e.primaryMetric] || e.primaryMetric).toLowerCase()}, with ${e.rules.length} automatic form checks.` : "";
        }
    };
    sel.addEventListener("change", desc);
    desc();
}

// ------------------------------------------------------------------ Patient List
async function refreshPatients() {
    if (isDemoMode) {
        patients = DEMO_PATIENTS;
        alertsByPatient = {};
        renderPatientList();
        renderPendingLinks();
        if (patients.length > 0) selectPatient(patients[0]);
        return;
    }

    try {
        patients = await getMyPatients(user.uid);
        const results = await Promise.allSettled(patients.map(p => getOpenAlerts(p.uid)));
        alertsByPatient = Object.fromEntries(patients.map((p, i) => [p.uid, results[i].status === "fulfilled" ? results[i].value : []]));
    } catch (e) {
        console.warn("Using demo data due to error fetching patients:", e);
        activateDemoMode();
        patients = DEMO_PATIENTS;
    }

    renderPatientList();
    renderPendingLinks();
    if (patients.length > 0 && !selected) selectPatient(patients[0]);
}

function renderPatientList() {
    const q = ($("patient-search")?.value || "").trim().toLowerCase();
    const list = $("patient-list");
    if (!list) return;
    list.replaceChildren();

    const shown = patients.filter(p => !q || (p.email || "").toLowerCase().includes(q) || (p.displayName || "").toLowerCase().includes(q) || (p.injury || "").toLowerCase().includes(q));

    if ($("patient-count")) $("patient-count").textContent = `${shown.length} under monitoring`;

    if (!shown.length) {
        list.appendChild(el("div", { class: "lumis-glass-subtle rounded-2xl p-4 text-center text-xs text-white/60" }, "No patients found matching your search."));
        return;
    }

    for (const p of shown) {
        const isCurrent = selected && selected.patient.uid === p.uid;
        const name = p.displayName || p.email;
        const injury = p.injury || (p.role === "patient" ? "Rehabilitation Patient" : "");
        const statusKind = p.statusKind || "green";
        const statusText = p.statusText || (statusKind === "amber" ? "Needs Review" : "On Track");

        const card = el("div", {
            class: `lumis-glass rounded-2xl p-3 flex items-center justify-between transition cursor-pointer active:scale-98 ${isCurrent ? 'border-teal-300/80 bg-white/25' : 'hover:bg-white/20'}`,
            onclick: () => selectPatient(p)
        },
            el("div", { class: "flex items-center space-x-3" },
                el("div", { class: "w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-xs font-semibold text-white border border-white/30" }, initials(name)),
                el("div", {},
                    el("div", { class: "flex items-center space-x-1.5" },
                        el("span", { class: "text-xs font-medium text-white" }, name),
                        el("span", { class: `w-1.5 h-1.5 rounded-full ${statusKind === 'amber' ? 'bg-amber-400 glow-dot-amber' : statusKind === 'red' ? 'bg-rose-400 glow-dot-red' : 'bg-emerald-400 glow-dot-green'}` })
                    ),
                    el("p", { class: "text-[11px] text-white/65" }, injury || p.email)
                )
            ),
            el("div", { class: "flex items-center space-x-2" },
                el("span", { class: `px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusKind === 'amber' ? 'bg-amber-400/20 text-amber-200 border-amber-400/30' : 'bg-emerald-400/20 text-emerald-200 border-emerald-400/30'}` }, statusText),
                el("span", { class: "text-white/40 text-xs" }, "›")
            )
        );
        list.appendChild(card);
    }
}

$("patient-search")?.addEventListener("input", renderPatientList);

function renderPendingLinks() {
    const box = $("pending-links");
    if (!box) return;
    box.replaceChildren();

    const links = isDemoMode ? DEMO_PENDING_LINKS : [];
    if (!links.length) {
        box.appendChild(el("div", { class: "lumis-glass-subtle rounded-2xl p-4 text-center text-xs text-white/60" }, "No pending invitations."));
        return;
    }

    for (const r of links) {
        box.appendChild(el("div", { class: "lumis-glass-subtle rounded-2xl p-3 flex items-center justify-between border-dashed border-white/30" },
            el("div", { class: "flex items-center space-x-3 opacity-80" },
                el("div", { class: "w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-xs font-semibold text-white/70 border border-white/20" }, "✉"),
                el("div", {},
                    el("p", { class: "text-xs font-medium text-white/90" }, r.patientEmail),
                    el("p", { class: "text-[11px] text-white/50" }, "Invitation sent")
                )
            ),
            el("button", {
                class: "px-2.5 py-1 rounded-full text-[10px] font-medium bg-white/20 text-white/80 hover:bg-white/30 active:scale-95 transition",
                type: "button",
                onclick: () => toast("Invitation link resent to " + r.patientEmail, "success")
            }, "Resend")
        ));
    }
}

// ------------------------------------------------------------------ Patient Selection & Telemetry
async function selectPatient(patient) {
    selected = {
        patient,
        sessions: patient.sessions || [],
        twin: buildTwin(patient.sessions || []),
        alerts: alertsByPatient[patient.uid] || [],
        prescriptions: patient.prescriptions || []
    };

    renderPatientList();
    updatePatientHeader(patient);

    if (!isDemoMode) {
        const [sessions, prescriptions, alerts] = await Promise.all([
            getSessions(patient.uid, 50).catch(() => []),
            getPrescriptions(patient.uid, "active").catch(() => []),
            getOpenAlerts(patient.uid).catch(() => [])
        ]);
        if (selected?.patient.uid === patient.uid) {
            Object.assign(selected, { sessions, prescriptions, alerts, twin: buildTwin(sessions) });
        }
    }

    renderRomChart();
    renderSessions();
    renderPrescriptions();
    renderQualityChart();
}

function updatePatientHeader(p) {
    const name = p.displayName || p.email;
    if ($("pt-avatar")) $("pt-avatar").textContent = initials(name);
    if ($("pt-name")) $("pt-name").textContent = name;
    if ($("pt-meta")) $("pt-meta").textContent = `${p.email} • ${p.injury || "Active Patient"}`;

    if ($("telemetry-patient-name")) $("telemetry-patient-name").textContent = `${name} • Movement Analysis`;
    if ($("chat-patient-name")) $("chat-patient-name").textContent = name;

    const accuracy = p.accuracy || 90;
    if ($("pt-accuracy-val")) $("pt-accuracy-val").textContent = accuracy;
    if ($("pt-accuracy-bar")) $("pt-accuracy-bar").style.width = `${accuracy}%`;

    const completed = p.exercisesCompleted || (p.sessions ? p.sessions.length : 3);
    const total = p.exercisesTotal || 5;
    if ($("pt-completed-val")) $("pt-completed-val").textContent = completed;
    if ($("pt-target-val")) $("pt-target-val").textContent = `/${total} completed`;
    if ($("pt-adherence-pct")) $("pt-adherence-pct").textContent = `${Math.round((completed / total) * 100)}%`;
    if ($("pt-adherence-bar")) $("pt-adherence-bar").style.width = `${Math.min(100, Math.round((completed / total) * 100))}%`;

    const rom = p.romDegrees || 124;
    const romTarget = p.romTarget || 130;
    if ($("rom-title")) $("rom-title").textContent = `Range of Motion (${p.romJoint || "Extension"})`;
    if ($("rom-degrees")) $("rom-degrees").innerHTML = `${rom}° <span class="text-[9px] font-normal text-white/60">/ ${romTarget}°</span>`;
}

// ------------------------------------------------------------------ ROM Waveform Chart
function renderRomChart() {
    const canvas = $("rom-chart");
    if (!canvas || !window.Chart) return;

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 0, 100);
    gradient.addColorStop(0, "rgba(45, 212, 191, 0.4)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

    new Chart(canvas, {
        type: "line",
        data: {
            labels: ["Warmup", "Set 1", "Set 2", "Peak", "Cooldown"],
            datasets: [{
                data: [45, 82, 105, selected?.patient?.romDegrees || 124, 75],
                borderColor: "rgba(255, 255, 255, 0.95)",
                borderWidth: 2.2,
                backgroundColor: gradient,
                fill: true,
                tension: 0.42,
                pointBackgroundColor: "#2dd4bf",
                pointBorderColor: "#ffffff",
                pointBorderWidth: 2,
                pointRadius: [0, 0, 0, 4.5, 0]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
                x: { display: false },
                y: { display: false, min: 20, max: 140 }
            }
        }
    });
}

function renderQualityChart() {
    const canvas = $("quality-chart");
    if (!canvas || !window.Chart) return;

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    new Chart(canvas, {
        type: "line",
        data: {
            labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Today"],
            datasets: [
                { label: "Quality Score", data: [82, 85, 84, 88, 90, 89, 92], borderColor: "#2dd4bf", tension: 0.35 },
                { label: "Consistency %", data: [75, 78, 80, 82, 85, 86, 88], borderColor: "#60a5fa", tension: 0.35 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: "rgba(255,255,255,0.8)", font: { size: 10 } } } },
            scales: {
                x: { ticks: { color: "rgba(255,255,255,0.6)", font: { size: 9 } } },
                y: { ticks: { color: "rgba(255,255,255,0.6)", font: { size: 9 } }, min: 50, max: 100 }
            }
        }
    });
}

// ------------------------------------------------------------------ Sessions List
function renderSessions() {
    const list = $("session-list");
    if (!list) return;
    list.replaceChildren();

    const sessions = selected?.sessions || [];
    if (!sessions.length) {
        list.appendChild(el("div", { class: "lumis-glass rounded-2xl p-4 text-center text-xs text-white/60" }, "No completed exercise sessions recorded yet."));
        return;
    }

    for (const s of sessions) {
        const quality = s.summary?.avgQuality ?? 90;
        const reps = s.validReps || 10;
        const dateStr = s.startedAt ? fmtDateTime(s.startedAt) : "Recent";

        const card = el("div", { class: "lumis-glass rounded-2xl p-3.5 space-y-2" },
            el("div", { class: "flex items-center justify-between" },
                el("div", {},
                    el("p", { class: "text-xs font-semibold text-white" }, s.exercise || "Rehabilitation Exercise"),
                    el("p", { class: "text-[10px] text-white/60" }, dateStr)
                ),
                el("span", { class: "px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-teal-400/20 text-teal-200 border border-teal-300/30" }, `${reps} Reps`)
            ),
            el("div", { class: "grid grid-cols-3 gap-2 pt-1 text-center text-[10px]" },
                el("div", { class: "lumis-glass-subtle rounded-xl p-1.5" },
                    el("span", { class: "text-white/60 block" }, "Form Quality"),
                    el("span", { class: "font-semibold text-teal-300" }, `${quality}/100`)
                ),
                el("div", { class: "lumis-glass-subtle rounded-xl p-1.5" },
                    el("span", { class: "text-white/60 block" }, "Consistency"),
                    el("span", { class: "font-semibold text-white" }, `${s.summary?.consistency ?? 85}%`)
                ),
                el("div", { class: "lumis-glass-subtle rounded-xl p-1.5" },
                    el("span", { class: "text-white/60 block" }, "Track Confidence"),
                    el("span", { class: "font-semibold text-emerald-300" }, `${100 - (s.summary?.lowConfidencePct ?? 0)}%`)
                )
            )
        );
        list.appendChild(card);
    }
}

// ------------------------------------------------------------------ Prescriptions
function renderPrescriptions() {
    const list = $("rx-list");
    if (!list) return;
    list.replaceChildren();

    const rxs = selected?.prescriptions || [];
    if (!rxs.length) {
        list.appendChild(el("div", { class: "lumis-glass rounded-2xl p-4 text-center text-xs text-white/60" }, "No active exercise prescriptions. Click '+ New Prescription' to assign one."));
        return;
    }

    for (const rx of rxs) {
        const item = el("div", { class: "lumis-glass rounded-2xl p-3.5 flex items-center justify-between" },
            el("div", { class: "space-y-1" },
                el("h4", { class: "text-xs font-semibold text-white" }, rx.exercise),
                el("p", { class: "text-[11px] text-white/70" }, `${rx.sets} sets × ${rx.reps} reps`),
                rx.notes ? el("p", { class: "text-[10px] text-teal-200/80 italic" }, `“${rx.notes}”`) : null
            ),
            el("span", { class: "px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-200 border border-emerald-400/30" }, "Active")
        );
        list.appendChild(item);
    }
}

// ------------------------------------------------------------------ Navigation / Tab Switching
function setupNavigation() {
    const tabs = [
        { pill: "pill-overview", dock: "dock-patients", view: "view-overview" },
        { pill: "pill-sessions", dock: "dock-sessions", view: "view-sessions" },
        { pill: "pill-protocols", dock: "dock-protocols", view: "view-protocols" },
        { pill: "pill-invites", dock: null, view: "view-invites" },
    ];

    function switchTab(targetView) {
        tabs.forEach(t => {
            const isMatch = t.view === targetView;
            if (t.pill && $(t.pill)) {
                $(t.pill).className = `tab-pill px-3.5 py-1.5 rounded-full text-xs font-medium shrink-0 transition ${isMatch ? 'lumis-pill-active' : 'lumis-pill-inactive'}`;
            }
            if (t.dock && $(t.dock)) {
                $(t.dock).className = `flex flex-col items-center transition-colors ${isMatch ? 'text-teal-300' : 'text-white/60 hover:text-white'}`;
            }
            show(t.view, isMatch);
        });
        if (targetView === "view-overview") renderRomChart();
    }

    tabs.forEach(t => {
        if (t.pill && $(t.pill)) $(t.pill).addEventListener("click", () => switchTab(t.view));
        if (t.dock && $(t.dock)) $(t.dock).addEventListener("click", () => switchTab(t.view));
    });

    $("dock-chat")?.addEventListener("click", () => show("chat-modal", true));
}

// ------------------------------------------------------------------ Modals & Actions
function setupModals() {
    // New Patient
    $("add-patient-btn")?.addEventListener("click", () => show("add-patient-modal", true));
    $("cancel-add-patient-btn")?.addEventListener("click", () => show("add-patient-modal", false));
    $("cancel-add-patient-btn-2")?.addEventListener("click", () => show("add-patient-modal", false));

    $("add-patient-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = $("new-patient-name").value.trim();
        const email = $("new-patient-email").value.trim();
        const password = $("new-patient-password").value;

        if (isDemoMode) {
            DEMO_PATIENTS.unshift({
                uid: "pt-" + Date.now(),
                displayName: name,
                email,
                injury: "New Patient Evaluation",
                statusText: "On Track",
                statusKind: "green",
                accuracy: 90,
                exercisesCompleted: 0,
                exercisesTotal: 4,
                romDegrees: 110,
                romTarget: 120,
                romJoint: "Knee Extension"
            });
            show("add-patient-modal", false);
            toast("Patient account created", "success");
            renderPatientList();
            return;
        }

        try {
            await createPatientAccount(email, password, user.uid, name);
            show("add-patient-modal", false);
            toast("Patient account created", "success");
            await refreshPatients();
        } catch (err) {
            $("add-patient-error").textContent = err.message;
            show("add-patient-error", true);
        }
    });

    // Invite Patient
    $("link-patient-btn")?.addEventListener("click", () => show("link-patient-modal", true));
    $("cancel-link-patient-btn")?.addEventListener("click", () => show("link-patient-modal", false));
    $("cancel-link-patient-btn-2")?.addEventListener("click", () => show("link-patient-modal", false));

    $("link-patient-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = $("link-patient-email").value.trim();
        if (isDemoMode) {
            DEMO_PENDING_LINKS.push({ id: "link-" + Date.now(), patientEmail: email, status: "pending" });
            show("link-patient-modal", false);
            toast("Invitation sent to " + email, "success");
            renderPendingLinks();
            return;
        }

        try {
            await createLinkRequest(profile, email);
            show("link-patient-modal", false);
            toast("Invitation sent", "success");
            renderPendingLinks();
        } catch (err) {
            $("link-patient-error").textContent = err.message;
            show("link-patient-error", true);
        }
    });

    // Prescribe Modal
    const openPrescribe = () => show("prescribe-modal", true);
    $("open-prescribe-modal-btn")?.addEventListener("click", openPrescribe);
    $("prescribe-tab-add-btn")?.addEventListener("click", openPrescribe);
    $("close-prescribe-modal-btn")?.addEventListener("click", () => show("prescribe-modal", false));
    $("close-prescribe-modal-btn-2")?.addEventListener("click", () => show("prescribe-modal", false));

    $("prescription-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const cfg = EXERCISES[$("exercise-select").value];
        const sets = +$("sets-input").value;
        const reps = +$("reps-input").value;
        const notes = $("notes-input").value.trim();

        if (isDemoMode) {
            if (!selected.patient.prescriptions) selected.patient.prescriptions = [];
            selected.patient.prescriptions.push({ id: "rx-" + Date.now(), exercise: cfg.name, exerciseId: cfg.id, sets, reps, notes });
            show("prescribe-modal", false);
            toast(`${cfg.name} assigned`, "success");
            renderPrescriptions();
            return;
        }

        try {
            await assignPrescription(user.uid, selected.patient.uid, {
                exerciseId: cfg.id, exercise: cfg.name, sets, reps, notes
            });
            show("prescribe-modal", false);
            toast(`${cfg.name} assigned`, "success");
            selected.prescriptions = await getPrescriptions(selected.patient.uid, "active");
            renderPrescriptions();
        } catch (err) {
            toast(err.message, "error");
        }
    });

    // Chat Drawer
    $("open-chat-btn")?.addEventListener("click", () => {
        show("chat-modal", true);
        renderChatMessages();
    });
    $("close-chat-btn")?.addEventListener("click", () => show("chat-modal", false));
    $("send-msg-btn")?.addEventListener("click", sendChatMessage);
    $("chat-input")?.addEventListener("keydown", e => { if (e.key === "Enter") sendChatMessage(); });

    // Full Telemetry Modal
    $("review-telemetry-btn")?.addEventListener("click", () => {
        show("telemetry-modal", true);
        setTimeout(renderQualityChart, 50);
    });
    $("close-telemetry-btn")?.addEventListener("click", () => show("telemetry-modal", false));

    // Export PDF
    $("export-pdf-btn")?.addEventListener("click", () => {
        if (!selected) { toast("Select a patient first", "warning"); return; }
        if (!window.jspdf) { toast("PDF exporter loading. Try again in a moment.", "warning"); return; }
        exportPatientReport(selected.patient, selected.twin, selected.sessions, selected.alerts);
    });

    // Sign out
    $("logout-btn")?.addEventListener("click", async () => {
        if (isDemoMode) {
            window.location.href = "./index.html";
            return;
        }
        await logout();
    });
}

function renderChatMessages() {
    const box = $("chat-messages");
    if (!box) return;
    box.replaceChildren();

    const msgs = selected?.patient?.chat || [];
    if (!msgs.length) {
        box.appendChild(el("div", { class: "text-center text-xs text-white/50 py-4" }, "No messages with this patient yet."));
        return;
    }

    for (const m of msgs) {
        const isMe = m.senderRole === "doctor";
        const bubble = el("div", { class: `p-2.5 rounded-2xl max-w-[85%] text-xs ${isMe ? 'ml-auto bg-teal-500 text-slate-900 font-medium' : 'mr-auto lumis-glass-subtle text-white'}` },
            el("p", { class: "font-semibold text-[10px] opacity-75 mb-0.5" }, isMe ? "You" : m.senderName),
            el("p", {}, m.text)
        );
        box.appendChild(bubble);
    }
}

async function sendChatMessage() {
    const text = $("chat-input")?.value.trim();
    if (!text || !selected) return;

    if (isDemoMode) {
        if (!selected.patient.chat) selected.patient.chat = [];
        selected.patient.chat.push({ id: "m-" + Date.now(), senderName: "Dr. R. Reynolds, MD", senderRole: "doctor", text, createdAt: new Date() });
        $("chat-input").value = "";
        renderChatMessages();
        return;
    }

    try {
        await sendMessage(selected.patient.uid, profile, text);
        $("chat-input").value = "";
    } catch (e) {
        toast(e.message, "error");
    }
}
