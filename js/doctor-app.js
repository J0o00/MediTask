// MediTask Clinical - Physiotherapist dashboard controller (Lumis aesthetic).
// Signed-in physiotherapists only ever see real patient data; on errors the page shows an error
// state, never sample data. Signed-out visitors get a clearly labelled, local-only demo.
import { requireRole, logout, createPatientAccount } from "./services/auth.js";
import {
    getMyPatients, unlinkPatient, createLinkRequest, getDoctorPendingLinks, cancelLinkRequest,
    assignPrescription, updatePrescription, getPrescriptions, getSessions, addSessionReview,
    getOpenAlerts, acknowledgeAlert, subscribeToChat, sendMessage,
} from "./services/db.js";
import { EXERCISES, resolveExercise } from "./rehabilitation/exercise-configs.js";
import { buildTwin } from "./digital-twin/progress-model.js";
import { exportPatientReport } from "./ui/report-generator.js";
import { $, el, show, toast, fmtDate, fmtDateTime, toDate, initials, METRIC_LABEL } from "./ui/dom.js";

const DAY = 864e5;
const WEEKLY_TARGET = 5;

let user, profile;
let isDemo = false;
let patients = [];
let alertsByPatient = {};
let sessionsCache = {};           // uid -> sessions (for roster status)
let pendingLinks = [];
let selected = null;              // { patient, sessions, prescriptions, alerts, twin }
let editingRx = null;
let chatUnsub = null, chatFor = null;
let demoStore = null;

// ------------------------------------------------------------------ demo (signed-out preview only)
function makeDemo() {
    const mk = (i, ex, exName, q0, rom0, pain) => ({
        id: `d-${ex}-${i}`, exerciseId: ex, exercise: exName, status: 'completed', validReps: 10, targetSets: 2, targetReps: 5,
        startedAt: new Date(Date.now() - (7 - i) * DAY),
        summary: { avgQuality: q0 + 3 * i, consistency: 78 + i, lowConfidencePct: 3, rom: { [ex === 'squat' ? 'knee_l' : 'shoulder_r']: { bestRange: rom0 + 4 * i, meanRange: rom0 + 3 * i } }, symmetry: {}, errorCounts: { [ex === 'squat' ? 'knee_valgus' : 'elbow_bent']: Math.max(0, 3 - i) } },
        reps: [], feedback: { pain, difficulty: 'medium' },
    });
    return {
        patients: [
            { uid: 'demo-pt-1', displayName: 'Sample patient A', email: 'patient.a@example.com', points: 60 },
            { uid: 'demo-pt-2', displayName: 'Sample patient B', email: 'patient.b@example.com', points: 20 },
        ],
        sessions: {
            'demo-pt-1': Array.from({ length: 6 }, (_, i) => mk(i, 'squat', 'Squat', 70, 60, 2)).reverse(),
            'demo-pt-2': Array.from({ length: 4 }, (_, i) => mk(i, 'shoulder_abduction', 'Shoulder Abduction', 64, 70, i === 3 ? 7 : 3)).reverse(),
        },
        prescriptions: {
            'demo-pt-1': [{ id: 'demo-rx1', exerciseId: 'squat', exercise: 'Squat', sets: 2, reps: 5, notes: 'Keep heels down.', assignedAt: new Date(Date.now() - 8 * DAY), status: 'active' }],
            'demo-pt-2': [{ id: 'demo-rx2', exerciseId: 'shoulder_abduction', exercise: 'Shoulder Abduction', sets: 2, reps: 8, notes: '', assignedAt: new Date(Date.now() - 5 * DAY), status: 'active' }],
        },
        alerts: { 'demo-pt-2': [{ id: 'demo-al1', type: 'pain', message: 'Pain 7/10 reported after Shoulder Abduction', createdAt: new Date(Date.now() - 3 * 3600e3) }] },
        chat: { 'demo-pt-1': [{ id: 'dm1', senderRole: 'patient', senderName: 'Sample patient A', text: 'The squats feel easier this week.', createdAt: new Date(Date.now() - 5 * 3600e3) }] },
        links: [{ id: 'demo-link', patientEmail: 'new.patient@example.com', createdAt: new Date(Date.now() - DAY) }],
    };
}

// ------------------------------------------------------------------ boot
(async function init() {
    try {
        ({ user, profile } = await requireRole('doctor'));
    } catch (e) {
        if (e?.code !== 'signed-out') console.warn(e);
        isDemo = true;
        demoStore = makeDemo();
        user = { uid: 'demo-doctor' };
        profile = { uid: 'demo-doctor', role: 'doctor', displayName: 'Demo physiotherapist', email: 'demo.physio@example.com' };
        show('demo-banner', true);
        const docSignup = $('doc-signup-btn');
        if (docSignup) {
            docSignup.classList.remove('hidden');
            docSignup.classList.add('flex');
        }
    }
    const name = profile.displayName || profile.email.split('@')[0];
    $('doctor-line').textContent = name;
    $('doctor-avatar').textContent = initials(name);

    populateExerciseSelect();
    setupNavigation();
    setupModals();
    await refreshPatients();
})();

// ------------------------------------------------------------------ data access (real or demo)
const api = {
    patients: () => isDemo ? Promise.resolve(demoStore.patients) : getMyPatients(user.uid),
    sessions: (uid) => isDemo ? Promise.resolve(demoStore.sessions[uid] || []) : getSessions(uid, 100),
    prescriptions: (uid) => isDemo ? Promise.resolve(demoStore.prescriptions[uid] || []) : getPrescriptions(uid, 'active'),
    alerts: (uid) => isDemo ? Promise.resolve(demoStore.alerts[uid] || []) : getOpenAlerts(uid),
    links: () => isDemo ? Promise.resolve(demoStore.links) : getDoctorPendingLinks(user.uid),
};

// ------------------------------------------------------------------ exercise select
function populateExerciseSelect() {
    const sel = $('exercise-select');
    sel.replaceChildren(...Object.values(EXERCISES).map(e => el('option', { value: e.id }, e.name)));
    sel.addEventListener('change', describeExercise);
    describeExercise();
}
function describeExercise() {
    const e = EXERCISES[$('exercise-select').value];
    $('exercise-desc').textContent = e
        ? `Range ${e.restValue}° to ${e.targetValue}° at the ${(METRIC_LABEL[e.primaryMetric] || e.primaryMetric).toLowerCase()}, with ${e.rules.length} automatic form checks.`
        : '';
}

// ------------------------------------------------------------------ roster
async function refreshPatients() {
    try {
        patients = await api.patients();
    } catch (e) {
        console.error('Patient list failed:', e);
        patients = [];
        $('patient-count').textContent = 'Unavailable';
        $('patient-list').replaceChildren(card('The patient list could not be loaded. Check your connection and reload the page.', 'text-rose-700'));
        $('hero-status').textContent = 'connection problem';
        return;
    }
    const [alerts, sess] = await Promise.all([
        Promise.allSettled(patients.map(p => api.alerts(p.uid))),
        Promise.allSettled(patients.map(p => api.sessions(p.uid))),
    ]);
    alertsByPatient = Object.fromEntries(patients.map((p, i) => [p.uid, alerts[i].status === 'fulfilled' ? alerts[i].value : []]));
    sessionsCache = Object.fromEntries(patients.map((p, i) => [p.uid, sess[i].status === 'fulfilled' ? sess[i].value : []]));
    // Patients needing attention first
    patients.sort((a, b) => rank(statusOf(b)) - rank(statusOf(a)) || (a.displayName || a.email).localeCompare(b.displayName || b.email));

    renderHero();
    renderPatientList();
    await renderPendingLinks();
    const keep = selected && patients.find(p => p.uid === selected.patient.uid);
    if (keep) await selectPatient(keep);
    else if (patients.length) await selectPatient(patients[0]);
    else clearSelection();
}

function statusOf(p) {
    const alerts = alertsByPatient[p.uid] || [];
    const sessions = sessionsCache[p.uid] || [];
    const twin = buildTwin(sessions);
    const last = toDate(sessions[0]?.startedAt);
    if (alerts.length) return { kind: 'red', text: alerts.length === 1 ? '1 alert' : `${alerts.length} alerts` };
    if (twin.flags.length) return { kind: 'amber', text: 'Needs review' };
    if (!sessions.length) return { kind: 'grey', text: 'No sessions yet' };
    if (last && Date.now() - last > 7 * DAY) return { kind: 'amber', text: 'Inactive 7+ days' };
    return { kind: 'green', text: 'On track' };
}
const rank = s => ({ red: 3, amber: 2, grey: 1, green: 0 }[s.kind]);
const DOT = { red: 'bg-rose-500', amber: 'bg-amber-500 glow-dot-amber', green: 'bg-emerald-500 glow-dot-green', grey: 'bg-stone-300' };
const BADGE = {
    red: 'bg-rose-50 text-rose-800 border-rose-200', amber: 'bg-amber-50 text-amber-800 border-amber-200',
    green: 'bg-emerald-50 text-emerald-800 border-emerald-200', grey: 'bg-stone-50 text-stone-600 border-stone-200',
};

function renderHero() {
    const totalAlerts = Object.values(alertsByPatient).reduce((n, a) => n + a.length, 0);
    const review = patients.filter(p => statusOf(p).kind === 'amber').length;
    if (!patients.length) { $('hero-line').textContent = 'No patients'; $('hero-status').textContent = 'yet'; return; }
    $('hero-line').textContent = `${patients.length} ${patients.length === 1 ? 'patient' : 'patients'}`;
    $('hero-status').textContent = totalAlerts ? `${totalAlerts} open ${totalAlerts === 1 ? 'alert' : 'alerts'}`
        : review ? `${review} to review` : 'all on track';
}

function card(text, tone = 'text-slate-light') {
    return el('div', { class: `lumis-glass-subtle rounded-2xl p-4 text-center text-xs border border-stone-200 ${tone}` }, text);
}

function renderPatientList() {
    const q = $('patient-search').value.trim().toLowerCase();
    const list = $('patient-list');
    const shown = patients.filter(p => !q || (p.email || '').toLowerCase().includes(q) || (p.displayName || '').toLowerCase().includes(q));
    $('patient-count').textContent = `${patients.length} under monitoring`;
    if (!patients.length) { list.replaceChildren(card('No patients yet. Use “Add patient” or “Invite” to get started.')); return; }
    if (!shown.length) { list.replaceChildren(card('No patients match your search.')); return; }

    list.replaceChildren(...shown.map(p => {
        const isCurrent = selected?.patient.uid === p.uid;
        const name = p.displayName || p.email;
        const st = statusOf(p);
        const last = sessionsCache[p.uid]?.[0];
        return el('button', {
            type: 'button',
            class: `w-full text-left lumis-glass rounded-2xl p-3 flex items-center justify-between transition active:scale-98 border ${isCurrent ? 'ring-2 ring-charcoal bg-white' : 'border-stone-200/80 hover:bg-white'}`,
            onclick: () => selectPatient(p), 'aria-current': isCurrent ? 'true' : null,
        },
            el('div', { class: 'flex items-center space-x-3 min-w-0' },
                el('div', { class: 'w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center text-xs font-semibold text-charcoal border border-stone-200 shrink-0' }, initials(name)),
                el('div', { class: 'min-w-0' },
                    el('div', { class: 'flex items-center space-x-1.5' },
                        el('span', { class: 'text-xs font-semibold text-charcoal truncate' }, name),
                        el('span', { class: `w-1.5 h-1.5 rounded-full ${DOT[st.kind]}` })),
                    el('p', { class: 'text-[11px] text-slate-light truncate' }, last ? `Last session ${fmtDate(last.startedAt)}` : p.email))),
            el('div', { class: 'flex items-center space-x-2 shrink-0' },
                el('span', { class: `px-2 py-0.5 rounded-full text-[10px] font-medium border ${BADGE[st.kind]}` }, st.text),
                el('span', { class: 'text-stone-400 text-xs' }, '›')));
    }));
}

// ------------------------------------------------------------------ pending invitations
async function renderPendingLinks() {
    const box = $('pending-links');
    try { pendingLinks = await api.links(); }
    catch (e) { console.warn('links', e); box.replaceChildren(card('Invitations could not be loaded.', 'text-rose-700')); return; }
    if (!pendingLinks.length) { box.replaceChildren(card('No pending invitations.')); return; }
    box.replaceChildren(...pendingLinks.map(r => el('div', { class: 'lumis-glass-subtle rounded-2xl p-3 flex items-center justify-between border border-dashed border-stone-300' },
        el('div', { class: 'flex items-center space-x-3 opacity-90 min-w-0' },
            el('div', { class: 'w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center text-xs font-semibold text-stone-500 border border-stone-200 shrink-0' }, '✉'),
            el('div', { class: 'min-w-0' },
                el('p', { class: 'text-xs font-semibold text-charcoal truncate' }, r.patientEmail),
                el('p', { class: 'text-[11px] text-slate-light' }, `Sent ${fmtDate(r.createdAt)}. The patient accepts it from their dashboard.`))),
        el('button', {
            class: 'px-2.5 py-1 rounded-full text-[10px] font-medium bg-stone-200/80 text-stone-700 hover:bg-stone-300 active:scale-95 transition shrink-0',
            type: 'button', onclick: () => withdrawLink(r),
        }, 'Withdraw'))));
}

async function withdrawLink(r) {
    try {
        if (isDemo) demoStore.links = demoStore.links.filter(x => x.id !== r.id);
        else await cancelLinkRequest(r.id);
        toast('Invitation withdrawn', 'success');
        await renderPendingLinks();
    } catch (e) { toast(`Could not withdraw: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ selected patient
function clearSelection() {
    selected = null;
    $('pt-name').textContent = 'No patient selected';
    $('pt-meta').textContent = 'Add or invite a patient to begin';
    $('pt-avatar').textContent = '';
    $('pt-status-text').textContent = '–';
    show('alerts-box', false);
    ['pt-accuracy-val', 'pt-completed-val', 'rom-degrees'].forEach(id => { $(id).textContent = '–'; });
    $('session-list').replaceChildren(card('Select a patient to see their sessions.'));
    $('rx-list').replaceChildren(card('Select a patient to manage their programme.'));
    Chart.getChart?.($('rom-chart'))?.destroy();
    stopChat();
}

async function selectPatient(patient) {
    const uid = patient.uid;
    selected = {
        patient, sessions: sessionsCache[uid] || [], prescriptions: [], alerts: alertsByPatient[uid] || [],
        twin: buildTwin(sessionsCache[uid] || []),
    };
    renderPatientList();
    renderHeader();
    const [sessions, prescriptions, alerts] = await Promise.allSettled([api.sessions(uid), api.prescriptions(uid), api.alerts(uid)]);
    if (selected?.patient.uid !== uid) return;              // user clicked another patient meanwhile
    if (sessions.status === 'fulfilled') { selected.sessions = sessions.value; sessionsCache[uid] = sessions.value; selected.twin = buildTwin(sessions.value); }
    if (prescriptions.status === 'fulfilled') selected.prescriptions = prescriptions.value;
    if (alerts.status === 'fulfilled') { selected.alerts = alerts.value; alertsByPatient[uid] = alerts.value; }
    selected.loadError = [sessions, prescriptions].some(r => r.status === 'rejected');

    renderHeader();
    renderAlerts();
    renderRomChart();
    renderSessions();
    renderPrescriptions();
    if (!$('chat-modal').classList.contains('hidden')) startChat();
    else stopChat();
}

function primaryExercise() {
    const t = selected.twin.exercises;
    const rxIds = selected.prescriptions.map(r => r.exerciseId);
    const id = rxIds.find(x => t[x]) || Object.keys(t).sort((a, b) => t[b].sessions - t[a].sessions)[0];
    return id ? t[id] : null;
}

function renderHeader() {
    const p = selected.patient;
    const name = p.displayName || p.email;
    $('pt-avatar').textContent = initials(name);
    $('pt-name').textContent = name;
    const last = toDate(selected.sessions[0]?.startedAt);
    $('pt-meta').textContent = `${p.email} • ${last ? `last session ${fmtDate(last)}` : 'no sessions yet'}`;
    $('telemetry-patient-name').textContent = `${name} • movement analysis`;
    $('chat-patient-name').textContent = name;

    const st = statusOf(p);
    $('pt-status-dot').className = `w-2 h-2 rounded-full ${DOT[st.kind]}`;
    $('pt-status-badge').className = `px-2.5 py-1 rounded-full text-[11px] font-medium border flex items-center space-x-1 ${BADGE[st.kind]}`;
    $('pt-status-badge').firstElementChild.className = `w-1.5 h-1.5 rounded-full ${DOT[st.kind].split(' ')[0]}`;
    $('pt-status-text').textContent = st.text;

    // Movement quality: mean of the last 10 sessions, change vs. baseline from the digital twin.
    const q = selected.sessions.slice(0, 10).map(s => s.summary?.avgQuality).filter(v => v > 0);
    const avgQ = q.length ? Math.round(q.reduce((a, b) => a + b, 0) / q.length) : null;
    $('pt-accuracy-val').textContent = avgQ ?? '–';
    $('pt-accuracy-bar').style.width = `${avgQ ?? 0}%`;
    const ex = primaryExercise();
    const dq = ex?.baselineReady ? ex.change.quality : null;
    $('pt-accuracy-delta').textContent = dq === null || dq === undefined ? '' : `${dq > 0 ? '+' : ''}${dq} vs baseline`;
    $('pt-accuracy-delta').className = `text-[10px] font-semibold ${dq > 0 ? 'text-emerald-700' : dq < 0 ? 'text-rose-700' : 'text-stone-500'}`;

    // Sessions in the last 7 days against a weekly target
    const since = Date.now() - 7 * DAY;
    const n7 = selected.sessions.filter(s => (toDate(s.startedAt)?.getTime() || 0) >= since).length;
    $('pt-completed-val').textContent = n7;
    $('pt-target-val').textContent = `/ ${WEEKLY_TARGET} target`;
    const pct = Math.min(100, Math.round(n7 / WEEKLY_TARGET * 100));
    $('pt-adherence-pct').textContent = `${pct}%`;
    $('pt-adherence-bar').style.width = `${pct}%`;
}

function renderAlerts() {
    const box = $('alerts-box');
    const items = [
        ...selected.alerts.map(a => ({ alert: a, text: a.message, when: a.createdAt, tone: 'rose' })),
        ...selected.twin.flags.map(f => ({ text: f.message, tone: 'amber' })),
    ];
    if (selected.loadError) items.push({ text: 'Some data for this patient could not be loaded. Figures may be incomplete.', tone: 'amber' });
    box.replaceChildren(...items.map(it => el('div', { class: `rounded-2xl p-2.5 flex items-start gap-2 border text-xs ${it.tone === 'rose' ? 'bg-rose-50/90 border-rose-200 text-rose-900' : 'bg-amber-50/90 border-amber-200 text-amber-900'}`, role: it.tone === 'rose' ? 'alert' : null },
        el('span', { class: 'font-bold' }, it.tone === 'rose' ? '!' : '•'),
        el('div', { class: 'flex-1' }, el('p', { class: 'font-medium' }, it.text), it.when ? el('p', { class: 'text-[10px] opacity-75' }, fmtDateTime(it.when)) : null),
        it.alert ? el('button', { type: 'button', class: 'px-2 py-0.5 rounded-full bg-white/80 border border-rose-200 text-[10px] font-semibold hover:bg-white', onclick: () => ackAlert(it.alert) }, 'Acknowledge') : null)));
    show(box, items.length > 0);
}

async function ackAlert(a) {
    const uid = selected.patient.uid;
    try {
        if (isDemo) demoStore.alerts[uid] = (demoStore.alerts[uid] || []).filter(x => x.id !== a.id);
        else await acknowledgeAlert(uid, a.id);
        selected.alerts = selected.alerts.filter(x => x.id !== a.id);
        alertsByPatient[uid] = selected.alerts;
        renderAlerts(); renderHeader(); renderHero(); renderPatientList();
        toast('Alert acknowledged', 'success');
    } catch (e) { toast(`Could not acknowledge: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ charts (real session data only)
const AXIS = { color: '#665D51', font: { size: 9 } };
function renderRomChart() {
    const canvas = $('rom-chart');
    Chart.getChart(canvas)?.destroy();
    const ex = primaryExercise();
    const points = ex ? ex.timeline.filter(t => Number.isFinite(t.rom)) : [];
    show('rom-empty', !points.length);
    if (!points.length) {
        $('rom-title').textContent = 'Range of Motion';
        $('rom-degrees').textContent = '–';
        $('twin-baseline-note').textContent = 'Best range per session, webcam pose estimation';
        return;
    }
    const cfg = resolveExercise(ex.exerciseId);
    $('rom-title').textContent = `Range of Motion (${ex.name})`;
    const latest = points.at(-1).rom;
    $('rom-degrees').replaceChildren(`${Math.round(latest)}°`, el('span', { class: 'text-[9px] font-normal text-stone-400' }, cfg ? ` / ${Math.abs(cfg.targetValue - cfg.restValue)}° target` : ''));
    $('twin-baseline-note').textContent = ex.baselineReady && Number.isFinite(ex.baseline.rom)
        ? `Baseline ${Math.round(ex.baseline.rom)}° (first 3 sessions), ${METRIC_LABEL[ex.primaryJoint] || ex.primaryJoint}`
        : `Baseline forming (${ex.sessions} of 3 sessions)`;

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 110);
    gradient.addColorStop(0, 'rgba(29, 28, 22, 0.15)');
    gradient.addColorStop(1, 'rgba(250, 248, 244, 0)');
    new Chart(canvas, {
        type: 'line',
        data: {
            labels: points.map(t => new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
            datasets: [{
                data: points.map(t => t.rom), borderColor: '#1D1C16', borderWidth: 2, backgroundColor: gradient, fill: true, tension: 0.35,
                pointBackgroundColor: '#1D1C16', pointBorderColor: '#FFFFFF', pointBorderWidth: 1.5, pointRadius: points.map((_, i) => (i === points.length - 1 ? 4.5 : 2)),
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${Math.round(c.parsed.y)}°` } } },
            scales: { x: { display: points.length > 1, grid: { display: false }, ticks: { ...AXIS, maxTicksLimit: 6 } }, y: { display: false, beginAtZero: false } },
        },
    });
}

function renderQualityChart() {
    const canvas = $('quality-chart');
    Chart.getChart(canvas)?.destroy();
    const ss = [...selected.sessions].filter(s => s.summary).reverse().slice(-20);
    if (!ss.length) { $('error-breakdown').replaceChildren(el('p', { class: 'text-stone-500 text-xs' }, 'No sessions recorded yet.')); return; }
    new Chart(canvas, {
        type: 'line',
        data: {
            labels: ss.map(s => fmtDate(s.startedAt, { month: 'short', day: 'numeric' })),
            datasets: [
                { label: 'Movement quality', data: ss.map(s => s.summary.avgQuality ?? null), borderColor: '#1D1C16', backgroundColor: '#1D1C16', tension: 0.35, spanGaps: true, pointRadius: 2 },
                { label: 'Consistency %', data: ss.map(s => s.summary.consistency ?? null), borderColor: '#9A8F80', backgroundColor: '#9A8F80', tension: 0.35, spanGaps: true, pointRadius: 2, borderDash: [4, 3] },
                { label: 'Pain (×10)', data: ss.map(s => (Number.isFinite(s.feedback?.pain) ? s.feedback.pain * 10 : null)), borderColor: '#be123c', backgroundColor: '#be123c', tension: 0.35, spanGaps: true, pointRadius: 2 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#1D1C16', font: { size: 10 }, boxWidth: 10 } } },
            scales: { x: { ticks: { ...AXIS, maxTicksLimit: 7 }, grid: { display: false } }, y: { ticks: AXIS, min: 0, max: 100 } },
        },
    });
    // Most frequent rule deviations over the last 10 sessions
    const counts = {};
    for (const s of selected.sessions.slice(0, 10)) {
        const cfg = resolveExercise(s.exerciseId);
        for (const [id, n] of Object.entries(s.summary?.errorCounts || {})) {
            const label = `${cfg?.name || s.exercise}: ${cfg?.rules.find(r => r.id === id)?.message || id}`;
            counts[label] = (counts[label] || 0) + n;
        }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('error-breakdown').replaceChildren(...(top.length
        ? top.map(([k, n]) => el('p', { class: 'flex justify-between gap-2' }, el('span', {}, k), el('span', { class: 'font-semibold text-charcoal shrink-0' }, `${n} ${n === 1 ? 'rep' : 'reps'}`)))
        : [el('p', { class: 'text-stone-500 text-xs' }, 'No significant deviations detected.')]));
}

// ------------------------------------------------------------------ sessions
function renderSessions() {
    const list = $('session-list');
    if (!selected.sessions.length) { list.replaceChildren(card('No exercise sessions recorded yet.')); return; }
    list.replaceChildren(...selected.sessions.slice(0, 30).map(sessionCard));
}

function sessionCard(s) {
    const sum = s.summary || {};
    const tile = (label, value, tone = 'text-charcoal') => el('div', { class: 'lumis-glass-subtle rounded-xl p-1.5 border border-stone-200' },
        el('span', { class: 'text-slate-light block' }, label), el('span', { class: `font-bold ${tone}` }, value));
    const statusBadge = s.emergencyStop ? ['Stopped (STOP)', 'bg-rose-50 text-rose-800 border-rose-200']
        : s.status === 'completed' ? [`${s.validReps ?? 0}/${(s.targetSets || 0) * (s.targetReps || 0)} reps`, 'bg-stone-100 text-charcoal border-stone-300']
            : ['Ended early', 'bg-amber-50 text-amber-800 border-amber-200'];
    const details = el('div', { class: 'hidden space-y-2 pt-2 border-t border-stone-200/70' });
    const rom = Object.entries(sum.rom || {});
    if (rom.length) details.appendChild(el('p', { class: 'text-[10px] text-slate-light' }, 'Range of motion: ', ...rom.map(([k, v], i) => `${i ? ', ' : ''}${METRIC_LABEL[k] || k} best ${v.bestRange}°`)));
    if (s.feedback) details.appendChild(el('p', { class: 'text-[10px] text-slate-light' },
        `Patient feedback: pain ${s.feedback.pain}/10, ${s.feedback.difficulty}`, s.feedback.notes ? ` — “${s.feedback.notes}”` : ''));
    if (s.reps?.length) details.appendChild(el('div', { class: 'flex flex-wrap gap-1' }, ...s.reps.slice(0, 60).map(r => el('span', {
        class: `px-1.5 py-0.5 rounded-md text-[9px] font-semibold border ${r.label === 'correct' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : r.label === 'incorrect' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-stone-50 text-stone-500 border-stone-200'}`,
        title: (r.messages || []).join('; ') || r.label,
    }, `#${r.index} ${Math.round(r.quality)}`))));
    const note = el('textarea', { class: 'w-full rounded-xl border border-stone-200 bg-white/80 text-xs p-2 focus:ring-1 focus:ring-stone-600 outline-none', rows: 2, maxlength: 2000, placeholder: 'Clinical note for this session' });
    note.value = s.review?.text || '';
    const save = el('button', { type: 'button', class: 'px-3 py-1 rounded-full bg-charcoal text-white text-[10px] font-semibold', onclick: async () => {
        try {
            if (!isDemo) await addSessionReview(selected.patient.uid, s.id, note.value.trim());
            s.review = { text: note.value.trim(), at: new Date().toISOString() };
            toast('Note saved', 'success');
        } catch (e) { toast(`Note not saved: ${e.message}`, 'error'); }
    } }, 'Save note');
    details.append(note, el('div', { class: 'flex justify-end' }, save));

    const toggle = el('button', { type: 'button', class: 'text-[10px] font-semibold text-stone-600 hover:text-charcoal', 'aria-expanded': 'false' }, s.review?.text ? 'Details • note' : 'Details');
    toggle.addEventListener('click', () => {
        const open = details.classList.toggle('hidden') === false;
        toggle.setAttribute('aria-expanded', String(open));
    });
    return el('div', { class: 'lumis-glass rounded-2xl p-3.5 space-y-2 border border-stone-200/80' },
        el('div', { class: 'flex items-center justify-between gap-2' },
            el('div', { class: 'min-w-0' },
                el('p', { class: 'text-xs font-semibold text-charcoal' }, s.exercise || 'Exercise'),
                el('p', { class: 'text-[10px] text-slate-light' }, s.startedAt ? fmtDateTime(s.startedAt) : '')),
            el('span', { class: `px-2.5 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 ${statusBadge[1]}` }, statusBadge[0])),
        el('div', { class: 'grid grid-cols-3 gap-2 pt-1 text-center text-[10px]' },
            tile('Quality', sum.avgQuality ? `${Math.round(sum.avgQuality)}/100` : '–'),
            tile('Consistency', Number.isFinite(sum.consistency) ? `${Math.round(sum.consistency)}%` : '–'),
            tile('Tracking', Number.isFinite(sum.lowConfidencePct) ? `${Math.round(100 - sum.lowConfidencePct)}%` : '–', 'text-emerald-700')),
        el('div', { class: 'flex justify-end' }, toggle),
        details);
}

// ------------------------------------------------------------------ prescriptions
function renderPrescriptions() {
    const list = $('rx-list');
    if (!selected.prescriptions.length) { list.replaceChildren(card('No active prescriptions. Use “New routine” to assign one.')); return; }
    list.replaceChildren(...selected.prescriptions.map(rx => {
        const done = selected.sessions.filter(s => s.prescriptionId === rx.id && s.status === 'completed').length;
        const btn = (label, onclick, cls = 'bg-stone-200/80 text-stone-700 hover:bg-stone-300') =>
            el('button', { type: 'button', class: `px-2.5 py-1 rounded-full text-[10px] font-medium active:scale-95 transition ${cls}`, onclick }, label);
        return el('div', { class: 'lumis-glass rounded-2xl p-3.5 flex items-center justify-between gap-3 border border-stone-200' },
            el('div', { class: 'space-y-1 min-w-0' },
                el('h4', { class: 'text-xs font-semibold text-charcoal' }, rx.exercise),
                el('p', { class: 'text-[11px] text-slate-light' }, `${rx.sets} sets × ${rx.reps} reps • assigned ${fmtDate(rx.assignedAt)} • completed ${done}×`),
                rx.notes ? el('p', { class: 'text-[10px] text-stone-600 italic' }, `“${rx.notes}”`) : null),
            el('div', { class: 'flex flex-col gap-1 shrink-0' },
                btn('Edit', () => openPrescribe(rx)),
                btn('Stop', () => stopPrescription(rx), 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100')));
    }));
}

async function stopPrescription(rx) {
    if (!confirm(`Stop “${rx.exercise}” for this patient? It disappears from their list; past sessions are kept.`)) return;
    try {
        if (isDemo) demoStore.prescriptions[selected.patient.uid] = demoStore.prescriptions[selected.patient.uid].filter(r => r.id !== rx.id);
        else await updatePrescription(selected.patient.uid, rx.id, { status: 'cancelled' });
        selected.prescriptions = selected.prescriptions.filter(r => r.id !== rx.id);
        renderPrescriptions();
        toast('Prescription stopped', 'success');
    } catch (e) { toast(`Could not stop: ${e.message}`, 'error'); }
}

function openPrescribe(rx = null) {
    if (!selected) { toast('Select a patient first', 'error'); return; }
    editingRx = rx;
    const heading = document.querySelector('#prescribe-modal h3');
    const submit = document.querySelector('#prescription-form [type="submit"]');
    heading.textContent = rx ? 'Edit prescription' : `Prescribe for ${selected.patient.displayName || selected.patient.email}`;
    submit.textContent = rx ? 'Save changes' : 'Assign prescription';
    $('exercise-select').value = rx?.exerciseId || $('exercise-select').value;
    $('exercise-select').disabled = !!rx;
    $('sets-input').value = rx?.sets ?? 2;
    $('reps-input').value = rx?.reps ?? 8;
    $('notes-input').value = rx?.notes ?? '';
    describeExercise();
    show('prescribe-modal', true);
}

// ------------------------------------------------------------------ chat
function stopChat() { chatUnsub?.(); chatUnsub = null; chatFor = null; }
function startChat() {
    if (!selected) return;
    const uid = selected.patient.uid;
    if (chatFor === uid) return;
    stopChat();
    chatFor = uid;
    if (isDemo) { renderChatMessages(demoStore.chat[uid] || []); return; }
    $('chat-messages').replaceChildren(el('p', { class: 'text-center text-xs text-slate-light py-4' }, 'Loading messages…'));
    chatUnsub = subscribeToChat(uid, renderChatMessages,
        e => { console.warn('chat', e); $('chat-messages').replaceChildren(el('p', { class: 'text-center text-xs text-rose-700 py-4' }, 'Messages could not be loaded.')); });
}

function renderChatMessages(msgs) {
    const box = $('chat-messages');
    if (!msgs.length) { box.replaceChildren(el('p', { class: 'text-center text-xs text-slate-light py-4' }, 'No messages with this patient yet.')); return; }
    box.replaceChildren(...msgs.map(m => {
        const mine = m.senderRole === 'doctor';
        return el('div', { class: `p-2.5 rounded-2xl max-w-[85%] text-xs ${mine ? 'ml-auto bg-charcoal text-white font-medium shadow-sm' : 'mr-auto lumis-glass-subtle text-charcoal border border-stone-200'}` },
            el('p', { class: 'font-semibold text-[10px] opacity-75 mb-0.5' }, mine ? 'You' : (m.senderName || 'Patient')),
            el('p', { class: 'whitespace-pre-wrap break-words' }, m.text),
            el('p', { class: 'text-[9px] opacity-60 mt-0.5 text-right' }, m.createdAt ? fmtDateTime(m.createdAt) : 'Sending…'));
    }));
    box.scrollTop = box.scrollHeight;
}

async function sendChatMessage() {
    const text = $('chat-input').value.trim();
    if (!text || !selected) return;
    if (isDemo) {
        const arr = (demoStore.chat[selected.patient.uid] ||= []);
        arr.push({ id: `m${Date.now()}`, senderRole: 'doctor', text, createdAt: new Date() });
        renderChatMessages(arr); $('chat-input').value = '';
        return;
    }
    try { await sendMessage(selected.patient.uid, profile, text); $('chat-input').value = ''; }
    catch (e) { toast(`Message not sent: ${e.message}`, 'error'); }
}

function openChat() {
    if (!selected) { toast('Select a patient first', 'error'); return; }
    show('chat-modal', true);
    startChat();
    $('chat-input').focus();
}

// ------------------------------------------------------------------ navigation
function setupNavigation() {
    const tabs = [
        { pill: 'pill-overview', dock: 'dock-patients', view: 'view-overview' },
        { pill: 'pill-sessions', dock: 'dock-sessions', view: 'view-sessions' },
        { pill: 'pill-protocols', dock: 'dock-protocols', view: 'view-protocols' },
        { pill: 'pill-invites', dock: null, view: 'view-invites' },
    ];
    const switchTab = (target) => {
        for (const t of tabs) {
            const on = t.view === target;
            $(t.pill).className = `tab-pill px-3.5 py-1.5 rounded-full text-xs font-medium shrink-0 transition ${on ? 'lumis-pill-active' : 'lumis-pill-inactive hover:bg-white'}`;
            $(t.pill).setAttribute('aria-pressed', String(on));
            if (t.dock) $(t.dock).className = `flex flex-col items-center transition-colors ${on ? 'text-charcoal font-bold' : 'text-stone-400 hover:text-charcoal'}`;
            show(t.view, on);
        }
        if (target === 'view-overview' && selected) renderRomChart();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    for (const t of tabs) {
        $(t.pill)?.addEventListener('click', () => switchTab(t.view));
        if (t.dock) $(t.dock)?.addEventListener('click', () => switchTab(t.view));
    }
    $('dock-chat')?.addEventListener('click', openChat);
}

// ------------------------------------------------------------------ modals & actions
function bindClose(modal, ...ids) { ids.forEach(id => $(id)?.addEventListener('click', () => show(modal, false))); }

function setupModals() {
    $('patient-search').addEventListener('input', renderPatientList);

    // Create patient account
    $('add-patient-btn').addEventListener('click', () => { $('add-patient-form').reset(); show('add-patient-error', false); show('add-patient-modal', true); });
    bindClose('add-patient-modal', 'cancel-add-patient-btn', 'cancel-add-patient-btn-2');
    $('add-patient-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('new-patient-name').value.trim(), email = $('new-patient-email').value.trim(), password = $('new-patient-password').value;
        const btn = $('submit-add-patient-btn');
        btn.disabled = true;
        try {
            if (isDemo) demoStore.patients.unshift({ uid: `demo-${Date.now()}`, displayName: name, email, points: 0 });
            else await createPatientAccount(email, password, user.uid, name);
            show('add-patient-modal', false);
            toast('Patient account created. Share the sign-in details with the patient.', 'success', 5000);
            await refreshPatients();
        } catch (err) {
            $('add-patient-error').textContent = err.code === 'auth/email-already-in-use'
                ? 'An account with this email already exists. Use “Invite” to link it instead.' : err.message;
            show('add-patient-error', true);
        } finally { btn.disabled = false; }
    });

    // Invite an existing patient
    $('link-patient-btn').addEventListener('click', () => { $('link-patient-form').reset(); show('link-patient-error', false); show('link-patient-modal', true); });
    bindClose('link-patient-modal', 'cancel-link-patient-btn', 'cancel-link-patient-btn-2');
    $('link-patient-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('link-patient-email').value.trim().toLowerCase();
        try {
            if (patients.some(p => p.email === email)) throw new Error('This patient is already on your roster.');
            if (pendingLinks.some(r => r.patientEmail === email)) throw new Error('An invitation to this email is already pending.');
            if (isDemo) demoStore.links.push({ id: `demo-${Date.now()}`, patientEmail: email, createdAt: new Date() });
            else await createLinkRequest(profile, email);
            show('link-patient-modal', false);
            toast(`Invitation sent to ${email}`, 'success');
            await renderPendingLinks();
        } catch (err) {
            $('link-patient-error').textContent = err.message;
            show('link-patient-error', true);
        }
    });

    // Prescribe / edit
    $('open-prescribe-modal-btn').addEventListener('click', () => openPrescribe());
    $('prescribe-tab-add-btn').addEventListener('click', () => openPrescribe());
    bindClose('prescribe-modal', 'close-prescribe-modal-btn', 'close-prescribe-modal-btn-2');
    $('prescription-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const cfg = EXERCISES[$('exercise-select').value];
        const sets = Math.round(+$('sets-input').value), reps = Math.round(+$('reps-input').value);
        const notes = $('notes-input').value.trim().slice(0, 1000);
        if (!(sets >= 1 && sets <= 10 && reps >= 1 && reps <= 50)) { toast('Use 1–10 sets and 1–50 repetitions', 'error'); return; }
        const uid = selected.patient.uid;
        try {
            if (editingRx) {
                if (isDemo) Object.assign(editingRx, { sets, reps, notes });
                else await updatePrescription(uid, editingRx.id, { sets, reps, notes });
                toast('Prescription updated', 'success');
            } else {
                if (isDemo) (demoStore.prescriptions[uid] ||= []).push({ id: `demo-rx-${Date.now()}`, exerciseId: cfg.id, exercise: cfg.name, sets, reps, notes, assignedAt: new Date(), status: 'active' });
                else await assignPrescription(user.uid, uid, { exerciseId: cfg.id, exercise: cfg.name, sets, reps, notes });
                toast(`${cfg.name} assigned`, 'success');
            }
            show('prescribe-modal', false);
            $('exercise-select').disabled = false;
            selected.prescriptions = await api.prescriptions(uid);
            renderPrescriptions();
        } catch (err) { toast(`Not saved: ${err.message}`, 'error'); }
    });

    // Chat drawer
    $('open-chat-btn').addEventListener('click', openChat);
    $('close-chat-btn').addEventListener('click', () => show('chat-modal', false));
    $('send-msg-btn').addEventListener('click', sendChatMessage);
    $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

    // Telemetry modal
    $('review-telemetry-btn').addEventListener('click', () => {
        if (!selected) { toast('Select a patient first', 'error'); return; }
        show('telemetry-modal', true);
        requestAnimationFrame(renderQualityChart);
    });
    $('close-telemetry-btn').addEventListener('click', () => show('telemetry-modal', false));

    $('export-pdf-btn').addEventListener('click', () => {
        if (!selected) return;
        if (!window.jspdf) { toast('The PDF exporter is still loading. Try again in a moment.', 'error'); return; }
        exportPatientReport(selected.patient, selected.twin, selected.sessions, selected.alerts);
    });

    $('unlink-btn').addEventListener('click', async () => {
        if (!selected) return;
        const name = selected.patient.displayName || selected.patient.email;
        if (!confirm(`Discharge ${name}? They will no longer appear on your roster and you lose access to their data. Their history is kept for them.`)) return;
        try {
            if (isDemo) demoStore.patients = demoStore.patients.filter(p => p.uid !== selected.patient.uid);
            else await unlinkPatient(selected.patient.uid);
            show('telemetry-modal', false);
            selected = null;
            toast(`${name} discharged`, 'success');
            await refreshPatients();
        } catch (e) { toast(`Could not discharge: ${e.message}`, 'error'); }
    });

    $('logout-btn').addEventListener('click', async () => {
        stopChat();
        if (isDemo) { window.location.href = './index.html'; return; }
        await logout();
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        ['chat-modal', 'telemetry-modal', 'prescribe-modal', 'add-patient-modal', 'link-patient-modal'].forEach(id => show(id, false));
        $('exercise-select').disabled = false;
    });
}

window.addEventListener('pagehide', stopChat);
