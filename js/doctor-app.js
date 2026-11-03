// MediTask Clinical - physiotherapist dashboard controller.
import { requireRole, logout, createPatientAccount } from "./services/auth.js";
import {
    getMyPatients, unlinkPatient, createLinkRequest, getDoctorPendingLinks, cancelLinkRequest,
    assignPrescription, updatePrescription, getPrescriptions, getSessions, addSessionReview,
    getOpenAlerts, acknowledgeAlert, subscribeToChat, sendMessage,
} from "./services/db.js";
import { EXERCISES, resolveExercise } from "./rehabilitation/exercise-configs.js";
import { buildTwin } from "./digital-twin/progress-model.js";
import { lineChart } from "./ui/charts.js";
import { exportPatientReport } from "./ui/report-generator.js";
import { $, el, show, toast, fmtDate, fmtDateTime, renderChat, METRIC_LABEL } from "./ui/dom.js";

let user, profile;
let patients = [];
let alertsByPatient = {};
let selected = null;        // { patient, sessions, twin, alerts, prescriptions }
let chatUnsub = null;

const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#facc15', '#34d399'];

// ------------------------------------------------------------------ boot
(async function init() {
    ({ user, profile } = await requireRole('doctor'));
    show('loading-view', false); show('main-content', true);
    $('doctor-line').textContent = `${profile.displayName || profile.email}`;
    populateExerciseSelect();
    await refreshPatients();
})();

$('logout-btn').addEventListener('click', () => logout());
$('mobile-menu-btn').addEventListener('click', () => { $('sidebar').classList.remove('hidden'); $('sidebar').classList.add('flex'); });
$('close-sidebar-btn').addEventListener('click', () => { $('sidebar').classList.add('hidden'); $('sidebar').classList.remove('flex'); });

function populateExerciseSelect() {
    const sel = $('exercise-select');
    sel.replaceChildren(...Object.values(EXERCISES).map(e => el('option', { value: e.id }, `${e.emoji} ${e.name}`)));
    const desc = () => {
        const e = EXERCISES[sel.value];
        $('exercise-desc').textContent = e ? `Target ${e.targetValue}° on ${METRIC_LABEL[e.primaryMetric] || e.primaryMetric} · ${e.rules.length} form checks` : '';
    };
    sel.addEventListener('change', desc); desc();
}

// ------------------------------------------------------------------ patient list
async function refreshPatients() {
    try {
        patients = await getMyPatients(user.uid);   // only patients assigned to this doctor
    } catch (e) {
        console.error('Load patients:', e);
        $('patient-list').textContent = 'Could not load patients.';
        return;
    }
    const results = await Promise.allSettled(patients.map(p => getOpenAlerts(p.uid)));
    alertsByPatient = Object.fromEntries(patients.map((p, i) => [p.uid, results[i].status === 'fulfilled' ? results[i].value : []]));
    renderPatientList();
    renderPendingLinks();
}

function renderPatientList() {
    const q = $('patient-search').value.trim().toLowerCase();
    const list = $('patient-list');
    list.replaceChildren();
    const shown = patients
        .filter(p => !q || (p.email || '').includes(q) || (p.displayName || '').toLowerCase().includes(q))
        .sort((a, b) => (alertsByPatient[b.uid]?.length || 0) - (alertsByPatient[a.uid]?.length || 0));
    if (!shown.length) {
        list.appendChild(el('p', { class: 'text-gray-400 p-3 text-sm' }, patients.length ? 'No match.' : 'No patients yet. Create an account or invite an existing patient.'));
        return;
    }
    for (const p of shown) {
        const n = alertsByPatient[p.uid]?.length || 0;
        const active = selected?.patient.uid === p.uid;
        list.appendChild(el('button', {
            class: `w-full text-left p-3 rounded-lg transition-colors flex justify-between items-center gap-2 ${active ? 'bg-teal-600' : 'bg-gray-900 hover:bg-teal-800'}`,
            onclick: () => selectPatient(p),
        },
            el('span', { class: 'min-w-0' },
                el('span', { class: 'block font-medium truncate' }, p.displayName || p.email),
                el('span', { class: 'block text-[11px] text-gray-400 truncate' }, p.email)),
            n ? el('span', { class: 'bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5', title: 'Open alerts' }, n) : null));
    }
}
$('patient-search').addEventListener('input', renderPatientList);

async function renderPendingLinks() {
    const box = $('pending-links');
    box.replaceChildren();
    let pending = [];
    try { pending = await getDoctorPendingLinks(user.uid); } catch (e) { console.warn(e); }
    if (!pending.length) { box.appendChild(el('p', {}, 'None')); return; }
    for (const r of pending) {
        box.appendChild(el('div', { class: 'flex justify-between items-center gap-2' },
            el('span', { class: 'truncate' }, r.patientEmail),
            el('button', { class: 'text-red-300 hover:underline', onclick: async () => { await cancelLinkRequest(r.id); renderPendingLinks(); } }, 'cancel')));
    }
}

// ------------------------------------------------------------------ patient detail
async function selectPatient(patient) {
    $('sidebar').classList.add('hidden'); $('sidebar').classList.remove('flex');
    $('sidebar').classList.add('md:flex');
    show('report-placeholder', false); show('patient-detail', true);
    $('pt-avatar').textContent = (patient.displayName || patient.email || '?')[0].toUpperCase();
    $('pt-name').textContent = patient.displayName || patient.email;
    $('pt-meta').textContent = `${patient.email} · ${patient.points || 0} points · consent ${patient.consent?.camera ? 'given' : 'pending'}`;
    selected = { patient, sessions: [], twin: buildTwin([]), alerts: alertsByPatient[patient.uid] || [], prescriptions: [] };
    renderPatientList();
    setTab('overview');
    $('session-list').replaceChildren(el('div', { class: 'loader mx-auto' }));

    const [sessions, prescriptions, alerts] = await Promise.all([
        getSessions(patient.uid, 100).catch(e => { console.error(e); return []; }),
        getPrescriptions(patient.uid, 'active').catch(e => { console.error(e); return []; }),
        getOpenAlerts(patient.uid).catch(() => []),
    ]);
    if (selected?.patient.uid !== patient.uid) return;   // user clicked another patient meanwhile
    Object.assign(selected, { sessions, prescriptions, alerts, twin: buildTwin(sessions) });
    renderAlerts(); renderTwin(); renderSessions(); renderPrescriptions();
}

function renderAlerts() {
    const box = $('alerts-box');
    box.replaceChildren();
    const { alerts, twin } = selected;
    for (const a of alerts) {
        box.appendChild(el('div', { class: 'bg-red-900/40 border border-red-500/60 rounded-xl px-4 py-2 flex justify-between items-center gap-3 text-sm' },
            el('span', {}, `⚠️ ${a.message} · ${fmtDateTime(a.createdAt)}`),
            el('button', { class: 'text-xs bg-red-500/80 px-3 py-1 rounded-lg', onclick: async () => {
                try { await acknowledgeAlert(selected.patient.uid, a.id); selected.alerts = selected.alerts.filter(x => x.id !== a.id); alertsByPatient[selected.patient.uid] = selected.alerts; renderAlerts(); renderPatientList(); }
                catch (e) { toast(e.message, 'error'); }
            } }, 'Mark reviewed')));
    }
    for (const f of twin.flags) {
        box.appendChild(el('div', { class: 'bg-amber-900/30 border border-amber-500/40 rounded-xl px-4 py-2 text-sm text-amber-100' }, `📉 ${f.message}`));
    }
}

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
function setTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('border-teal-400', on); b.classList.toggle('text-teal-300', on);
        b.classList.toggle('border-transparent', !on); b.classList.toggle('text-gray-400', !on);
    });
    document.querySelectorAll('.tab-panel').forEach(p => show(p, p.id === `tab-${name}`));
}

// ------------------------------------------------------------------ digital twin
function renderTwin() {
    const { twin } = selected;
    const sel = $('twin-exercise');
    const ids = Object.keys(twin.exercises);
    sel.replaceChildren(...(ids.length ? ids.map(id => el('option', { value: id }, twin.exercises[id].name)) : [el('option', { value: '' }, 'No sessions yet')]));
    sel.onchange = renderTwinExercise;
    renderTwinExercise();

    // error breakdown across recent sessions
    const counts = {};
    for (const s of selected.sessions.slice(0, 10)) {
        const cfg = resolveExercise(s.exerciseId);
        for (const [id, n] of Object.entries(s.summary?.errorCounts || {})) {
            const key = `${cfg?.name || s.exerciseId}: ${cfg?.rules.find(r => r.id === id)?.message || id}`;
            counts[key] = (counts[key] || 0) + n;
        }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('error-breakdown').replaceChildren(...(top.length ? top.map(([k, n]) => el('p', {}, `• ${k} - ${n} rep(s)`)) : [el('p', { class: 'text-gray-500' }, 'No deviations recorded.')]));
}

function renderTwinExercise() {
    const ex = selected.twin.exercises[$('twin-exercise').value];
    const tiles = $('twin-tiles');
    tiles.replaceChildren();
    if (!ex) {
        $('twin-baseline-note').textContent = '';
        lineChart($('rom-chart'), [], []); lineChart($('quality-chart'), [], []);
        tiles.appendChild(el('p', { class: 'col-span-full text-gray-400 text-sm' }, 'The digital twin is built from completed sessions. None recorded yet.'));
        return;
    }
    $('twin-baseline-note').textContent = ex.baselineReady ? `Baseline = first 3 sessions · ${ex.sessions} sessions total` : `Baseline forming (${ex.sessions}/3 sessions)`;
    const tile = (label, cur, chg, unit, goodUp = true) => {
        const good = chg === null || chg === 0 ? null : (goodUp ? chg > 0 : chg < 0);
        tiles.appendChild(el('div', { class: 'glass rounded-xl p-3' },
            el('p', { class: 'text-xs text-gray-400' }, label),
            el('p', { class: 'text-2xl font-bold' }, cur === null ? '--' : `${cur}${unit}`),
            el('p', { class: `text-xs ${good === null ? 'text-gray-500' : good ? 'text-green-400' : 'text-red-400'}` },
                chg === null ? 'vs baseline: n/a' : chg === 0 ? 'no change vs baseline' : `${chg > 0 ? '▲' : '▼'} ${Math.abs(chg)}${unit} vs baseline`)));
    };
    tile(`ROM · ${METRIC_LABEL[ex.primaryJoint] || ex.primaryJoint}`, ex.current.rom, ex.change.rom, '°');
    tile('Movement quality', ex.current.quality, ex.change.quality, '');
    tile('L-R asymmetry', ex.current.symmetry, ex.change.symmetry, '°', false);
    tile('Reported pain', ex.current.pain, ex.change.pain, '', false);

    const labels = ex.timeline.map(t => new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    const joints = [...new Set(ex.timeline.flatMap(t => Object.keys(t.romByJoint)))];
    lineChart($('rom-chart'), labels, joints.map((j, i) => ({ label: METRIC_LABEL[j] || j, data: ex.timeline.map(t => t.romByJoint[j] ?? null), color: COLORS[i % COLORS.length] })), { yTitle: 'degrees' });
    lineChart($('quality-chart'), labels, [
        { label: 'Quality', data: ex.timeline.map(t => t.quality), color: '#a78bfa' },
        { label: 'Consistency %', data: ex.timeline.map(t => t.consistency), color: '#34d399' },
        { label: 'Asymmetry °', data: ex.timeline.map(t => t.symmetry), color: '#facc15' },
        { label: 'Pain', data: ex.timeline.map(t => t.pain), color: '#f87171', axis: 'y2', dashed: true },
    ], { yTitle: 'score', y2Title: 'pain', y2Max: 10 });
}

// ------------------------------------------------------------------ sessions
function renderSessions() {
    const list = $('session-list');
    list.replaceChildren();
    if (!selected.sessions.length) { list.appendChild(el('p', { class: 'text-gray-400 text-sm' }, 'No sessions yet.')); return; }
    for (const s of selected.sessions) {
        const sm = s.summary || {};
        const statusCls = s.status === 'completed' ? 'text-green-300' : 'text-amber-300';
        const details = el('div', { class: 'hidden mt-3 space-y-2' });
        const header = el('button', { class: 'w-full text-left flex flex-wrap justify-between gap-2', onclick: () => details.classList.toggle('hidden') },
            el('span', {},
                el('span', { class: 'font-semibold' }, `${s.exercise} `),
                el('span', { class: `text-xs ${statusCls}` }, s.emergencyStop ? 'STOP pressed' : s.status),
                el('span', { class: 'block text-xs text-gray-400' }, fmtDateTime(s.startedAt))),
            el('span', { class: 'text-sm text-gray-300' },
                `reps ${s.validReps}/${(s.targetSets || 0) * (s.targetReps || 0)} · quality ${sm.avgQuality ?? '-'} · consistency ${sm.consistency ?? '-'}%`,
                s.feedback ? ` · pain ${s.feedback.pain}/10 (${s.feedback.difficulty})` : ''));

        const rom = Object.entries(sm.rom || {}).map(([k, v]) => `${METRIC_LABEL[k] || k} ${v.bestRange}°`).join(', ');
        details.append(
            el('p', { class: 'text-xs text-gray-400' }, `ROM: ${rom || 'n/a'} · tracking lost ${sm.lowConfidencePct ?? 0}% of frames · ${sm.fps ?? '-'} fps · template ${sm.templateSource || '-'}${sm.mlModel ? ` · model ${sm.mlModel}` : ''}`),
            sm.performanceDecline ? el('p', { class: 'text-xs text-amber-300' }, 'Within-session performance decline detected (experimental indicator).') : null,
            s.feedback?.notes ? el('p', { class: 'text-sm' }, `Patient note: "${s.feedback.notes}"`) : null,
            repTable(s),
            reviewBox(s));
        list.appendChild(el('div', { class: 'glass rounded-xl p-4' }, header, details));
    }
}

function repTable(s) {
    const cfg = resolveExercise(s.exerciseId);
    const rows = (s.reps || []).map(r => el('tr', { class: 'border-t border-gray-700' },
        el('td', { class: 'py-1 pr-2' }, r.index),
        el('td', { class: 'pr-2' }, r.label),
        el('td', { class: 'pr-2' }, Math.round(r.quality)),
        el('td', { class: 'pr-2' }, `${(r.durationMs / 1000).toFixed(1)}s`),
        el('td', { class: 'pr-2' }, r.ml ? `${r.ml.quality} (${Math.round(r.ml.qualityProb * 100)}%)` : '-'),
        el('td', {}, (r.errors || []).map(e => cfg?.rules.find(x => x.id === e.id)?.message || e.id).join('; ') || '-')));
    return el('div', { class: 'overflow-x-auto' }, el('table', { class: 'w-full text-xs text-gray-300' },
        el('thead', {}, el('tr', { class: 'text-gray-400 text-left' }, ...['#', 'Label', 'Quality', 'Time', 'AI model', 'Deviations'].map(h => el('th', { class: 'pr-2 pb-1' }, h)))),
        el('tbody', {}, ...rows)));
}

function reviewBox(s) {
    if (s.review) return el('p', { class: 'text-sm text-teal-200' }, `Your review: ${s.review.text}`);
    const input = el('input', { class: 'flex-1 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-1.5 text-sm', placeholder: 'Add a clinical review note...', maxlength: '2000' });
    const btn = el('button', { class: 'bg-teal-500 text-black text-sm font-semibold px-3 rounded-lg', onclick: async () => {
        if (!input.value.trim()) return;
        try { await addSessionReview(selected.patient.uid, s.id, input.value.trim()); s.review = { text: input.value.trim() }; renderSessions(); }
        catch (e) { toast(e.message, 'error'); }
    } }, 'Save');
    return el('div', { class: 'flex gap-2' }, input, btn);
}

// ------------------------------------------------------------------ prescriptions
function renderPrescriptions() {
    const list = $('rx-list');
    list.replaceChildren();
    if (!selected.prescriptions.length) { list.appendChild(el('p', { class: 'text-gray-400 text-sm' }, 'No active prescriptions.')); return; }
    for (const rx of selected.prescriptions) {
        const cfg = resolveExercise(rx.exerciseId || rx.exercise);
        const sets = el('input', { type: 'number', min: '1', max: '20', value: rx.sets, class: 'w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1' });
        const reps = el('input', { type: 'number', min: '1', max: '100', value: rx.reps, class: 'w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1' });
        list.appendChild(el('div', { class: 'glass rounded-xl p-3 text-sm space-y-2' },
            el('div', { class: 'flex justify-between' }, el('span', { class: 'font-semibold' }, `${cfg?.emoji || ''} ${cfg?.name || rx.exercise}`), el('span', { class: 'text-xs text-gray-400' }, `assigned ${fmtDate(rx.assignedAt)}`)),
            rx.notes ? el('p', { class: 'text-xs text-gray-400' }, rx.notes) : null,
            el('div', { class: 'flex items-center gap-2 flex-wrap' }, sets, el('span', {}, 'sets ×'), reps, el('span', {}, 'reps'),
                el('button', { class: 'ml-auto bg-teal-600 px-3 py-1 rounded-lg text-xs', onclick: () => editRx(rx, { sets: +sets.value, reps: +reps.value }) }, 'Update'),
                el('button', { class: 'bg-red-600/80 px-3 py-1 rounded-lg text-xs', onclick: () => editRx(rx, { status: 'cancelled' }) }, 'Cancel'))));
    }
}

async function editRx(rx, changes) {
    const next = { sets: rx.sets, reps: rx.reps, notes: rx.notes || '', status: 'active', ...changes };
    try {
        await updatePrescription(selected.patient.uid, rx.id, next);
        toast(changes.status === 'cancelled' ? 'Prescription cancelled' : 'Prescription updated', 'success');
        selected.prescriptions = await getPrescriptions(selected.patient.uid, 'active');
        renderPrescriptions();
    } catch (e) { toast(`Update failed: ${e.message}`, 'error'); }
}

$('prescription-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected) return;
    const cfg = EXERCISES[$('exercise-select').value];
    try {
        await assignPrescription(user.uid, selected.patient.uid, {
            exerciseId: cfg.id, exercise: cfg.name,
            sets: +$('sets-input').value, reps: +$('reps-input').value, notes: $('notes-input').value.trim(),
        });
        toast(`${cfg.name} assigned`, 'success');
        $('notes-input').value = '';
        selected.prescriptions = await getPrescriptions(selected.patient.uid, 'active');
        renderPrescriptions();
    } catch (err) { console.error(err); toast(`Could not assign: ${err.message}`, 'error'); }
});

// ------------------------------------------------------------------ actions
$('export-pdf-btn').addEventListener('click', () => {
    if (!selected) return;
    if (!window.jspdf) { toast('PDF library still loading, try again', 'error'); return; }
    exportPatientReport(selected.patient, selected.twin, selected.sessions, selected.alerts);
});

$('unlink-btn').addEventListener('click', async () => {
    if (!selected || !confirm(`Stop supervising ${selected.patient.email}? You will lose access to their records.`)) return;
    try {
        await unlinkPatient(selected.patient.uid);
        selected = null; show('patient-detail', false); show('report-placeholder', true);
        await refreshPatients();
    } catch (e) { toast(e.message, 'error'); }
});

// ------------------------------------------------------------------ chat
$('open-chat-btn').addEventListener('click', () => {
    if (!selected) return;
    $('chat-patient-name').textContent = `💬 ${selected.patient.displayName || selected.patient.email}`;
    show('chat-modal', true);
    chatUnsub?.();
    chatUnsub = subscribeToChat(selected.patient.uid, msgs => renderChat($('chat-messages'), msgs, user.uid), e => toast(e.message, 'error'));
});
$('close-chat-btn').addEventListener('click', () => { show('chat-modal', false); chatUnsub?.(); chatUnsub = null; });
$('send-msg-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
    const text = $('chat-input').value.trim();
    if (!text || !selected) return;
    try { await sendMessage(selected.patient.uid, profile, text); $('chat-input').value = ''; }
    catch (e) { toast(`Not sent: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ add / invite patient
$('add-patient-btn').addEventListener('click', () => { $('add-patient-form').reset(); show('add-patient-error', false); show('add-patient-modal', true); });
$('cancel-add-patient-btn').addEventListener('click', () => show('add-patient-modal', false));
$('add-patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('submit-add-patient-btn');
    btn.disabled = true; btn.textContent = 'Creating...';
    try {
        await createPatientAccount($('new-patient-email').value, $('new-patient-password').value, user.uid, $('new-patient-name').value.trim());
        show('add-patient-modal', false);
        toast('Patient account created', 'success');
        await refreshPatients();
    } catch (err) {
        $('add-patient-error').textContent = err.code === 'auth/email-already-in-use'
            ? 'That email already has an account - use "Invite existing patient" instead.' : `Error: ${err.message}`;
        show('add-patient-error', true);
    } finally { btn.disabled = false; btn.textContent = 'Create'; }
});

$('link-patient-btn').addEventListener('click', () => { $('link-patient-form').reset(); show('link-patient-error', false); show('link-patient-modal', true); });
$('cancel-link-patient-btn').addEventListener('click', () => show('link-patient-modal', false));
$('link-patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await createLinkRequest(profile, $('link-patient-email').value);
        show('link-patient-modal', false);
        toast('Invitation sent. The patient must accept it from their dashboard.', 'success', 5000);
        renderPendingLinks();
    } catch (err) {
        $('link-patient-error').textContent = err.message;
        show('link-patient-error', true);
    }
});
