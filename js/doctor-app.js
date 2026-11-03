// MediTask Clinical - physiotherapist dashboard controller.
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
import { icon, exerciseIcon, hydrateIcons } from "./ui/icons.js";
import { $, el, show, toast, fmtDate, fmtDateTime, renderChat, initials, METRIC_LABEL } from "./ui/dom.js";

let user, profile;
let patients = [];
let alertsByPatient = {};
let selected = null;        // { patient, sessions, twin, alerts, prescriptions }
let chatUnsub = null;

const COLORS = [SERIES.primary, SERIES.blue, SERIES.amber, SERIES.teal2, SERIES.grey];
const STATUS = {
    completed: ['Completed', 'success'], stopped: ['Ended early', 'warning'], interrupted: ['Interrupted', 'warning'],
};
const ALERT_LABEL = { pain: 'High pain reported', pain_increase: 'Pain above baseline', emergency_stop: 'Stop button pressed', quality_decline: 'Quality declining' };

hydrateIcons();

// ------------------------------------------------------------------ boot
(async function init() {
    ({ user, profile } = await requireRole('doctor'));
    show('loading-view', false); show('main-content', true);
    const name = profile.displayName || profile.email.split('@')[0];
    $('doctor-line').textContent = name;
    $('doctor-avatar').textContent = initials(name);
    populateExerciseSelect();
    await refreshPatients();
})();

$('logout-btn').addEventListener('click', () => logout());
$('mobile-menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));

function populateExerciseSelect() {
    const sel = $('exercise-select');
    sel.replaceChildren(...Object.values(EXERCISES).map(e => el('option', { value: e.id }, e.name)));
    const desc = () => {
        const e = EXERCISES[sel.value];
        $('exercise-desc').textContent = e ? `Target ${e.targetValue}° at the ${(METRIC_LABEL[e.primaryMetric] || e.primaryMetric).toLowerCase()}, with ${e.rules.length} automatic form checks.` : '';
    };
    sel.addEventListener('change', desc); desc();
}

// ------------------------------------------------------------------ patient list
async function refreshPatients() {
    try {
        patients = await getMyPatients(user.uid);   // only patients assigned to this doctor
    } catch (e) {
        console.error('Load patients:', e);
        $('patient-list').replaceChildren(el('p', { class: 'empty small' }, 'Patients could not be loaded. Reload the page to try again.'));
        return;
    }
    const results = await Promise.allSettled(patients.map(p => getOpenAlerts(p.uid)));
    alertsByPatient = Object.fromEntries(patients.map((p, i) => [p.uid, results[i].status === 'fulfilled' ? results[i].value : []]));
    $('patient-count').textContent = patients.length ? `(${patients.length})` : '';
    renderPatientList();
    renderPendingLinks();
}

function renderPatientList() {
    const q = $('patient-search').value.trim().toLowerCase();
    const list = $('patient-list');
    list.replaceChildren();
    const shown = patients
        .filter(p => !q || (p.email || '').includes(q) || (p.displayName || '').toLowerCase().includes(q))
        .sort((a, b) => (alertsByPatient[b.uid]?.length || 0) - (alertsByPatient[a.uid]?.length || 0)
            || (a.displayName || a.email).localeCompare(b.displayName || b.email));
    if (!shown.length) {
        list.appendChild(el('div', { class: 'empty small' }, patients.length
            ? 'No patients match your search.'
            : [el('h3', {}, 'No patients yet'), 'Create an account for a new patient or invite an existing one.']));
        return;
    }
    for (const p of shown) {
        const n = alertsByPatient[p.uid]?.length || 0;
        const name = p.displayName || p.email;
        list.appendChild(el('button', {
            class: 'patient-item', type: 'button', 'aria-current': String(selected?.patient.uid === p.uid),
            onclick: () => selectPatient(p),
        },
            el('span', { class: 'avatar' }, initials(name)),
            el('span', { class: 'grow' },
                el('span', { class: 'truncate strong block' }, name),
                el('span', { class: 'truncate tiny muted block' }, p.email)),
            n ? el('span', { class: 'count-dot', title: `${n} alert${n > 1 ? 's' : ''} to review` }, n) : null));
    }
}
$('patient-search').addEventListener('input', renderPatientList);

async function renderPendingLinks() {
    const box = $('pending-links');
    box.replaceChildren();
    let pending = [];
    try { pending = await getDoctorPendingLinks(user.uid); } catch (e) { console.warn(e); }
    if (!pending.length) { box.appendChild(el('p', { class: 'muted' }, 'None')); return; }
    for (const r of pending) {
        box.appendChild(el('div', { class: 'row between' },
            el('span', { class: 'truncate' }, r.patientEmail),
            el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { await cancelLinkRequest(r.id); renderPendingLinks(); } }, 'Withdraw')));
    }
}

// ------------------------------------------------------------------ patient record
async function selectPatient(patient) {
    $('sidebar').classList.add('collapsed');
    show('report-placeholder', false); show('patient-detail', true);
    const name = patient.displayName || patient.email;
    $('pt-avatar').textContent = initials(name);
    $('pt-name').textContent = name;
    $('pt-meta').replaceChildren(
        el('span', {}, patient.email),
        el('span', {}, el('b', {}, patient.points || 0), ' points'),
        el('span', { class: `badge ${patient.consent?.camera ? 'success' : 'warning'}` }, patient.consent?.camera ? 'Camera consent given' : 'Consent pending'));
    selected = { patient, sessions: [], twin: buildTwin([]), alerts: alertsByPatient[patient.uid] || [], prescriptions: [] };
    renderPatientList();
    setTab('overview');
    $('session-list').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'spinner' })));

    const [sessions, prescriptions, alerts] = await Promise.all([
        getSessions(patient.uid, 100).catch(e => { console.error(e); return []; }),
        getPrescriptions(patient.uid, 'active').catch(e => { console.error(e); return []; }),
        getOpenAlerts(patient.uid).catch(() => []),
    ]);
    if (selected?.patient.uid !== patient.uid) return;   // another patient was selected meanwhile
    Object.assign(selected, { sessions, prescriptions, alerts, twin: buildTwin(sessions) });
    renderAlerts(); renderTwin(); renderSessions(); renderPrescriptions();
}

function renderAlerts() {
    const box = $('alerts-box');
    box.replaceChildren();
    const { alerts, twin } = selected;
    for (const a of alerts) {
        box.appendChild(el('div', { class: 'banner danger' }, icon('alert'),
            el('div', { class: 'grow' },
                el('p', { class: 'strong' }, ALERT_LABEL[a.type] || 'Alert'),
                el('p', { class: 'small' }, `${a.message}, ${fmtDateTime(a.createdAt)}`)),
            el('div', { class: 'banner-actions' },
                el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: async () => {
                    try {
                        await acknowledgeAlert(selected.patient.uid, a.id);
                        selected.alerts = selected.alerts.filter(x => x.id !== a.id);
                        alertsByPatient[selected.patient.uid] = selected.alerts;
                        renderAlerts(); renderPatientList();
                    } catch (e) { toast(e.message, 'error'); }
                } }, 'Mark as reviewed'))));
    }
    for (const f of twin.flags) {
        box.appendChild(el('div', { class: 'banner warning' }, icon('trend'), el('p', {}, f.message)));
    }
    show(box, box.childElementCount > 0);
}

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
function setTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
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

    const counts = {};
    for (const s of selected.sessions.slice(0, 10)) {
        const cfg = resolveExercise(s.exerciseId);
        for (const [id, n] of Object.entries(s.summary?.errorCounts || {})) {
            const key = `${cfg?.name || s.exerciseId}|${cfg?.rules.find(r => r.id === id)?.message || id}`;
            counts[key] = (counts[key] || 0) + n;
        }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const box = $('error-breakdown');
    if (!top.length) { box.replaceChildren(el('p', { class: 'muted' }, 'No movement deviations recorded.')); return; }
    box.replaceChildren(el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Exercise'), el('th', {}, 'Deviation'), el('th', {}, 'Repetitions'))),
        el('tbody', {}, ...top.map(([k, n]) => { const [ex, msg] = k.split('|'); return el('tr', {}, el('td', {}, ex), el('td', {}, msg), el('td', {}, n)); }))));
}

function renderTwinExercise() {
    const ex = selected.twin.exercises[$('twin-exercise').value];
    const tiles = $('twin-tiles');
    tiles.replaceChildren();
    if (!ex) {
        $('twin-baseline-note').textContent = '';
        lineChart($('rom-chart'), [], []); lineChart($('quality-chart'), [], []);
        tiles.classList.remove('strip');
        tiles.appendChild(el('div', { class: 'panel empty' }, el('h3', {}, 'No sessions yet'), 'The progress record builds automatically from completed sessions.'));
        return;
    }
    tiles.classList.add('strip');
    $('twin-baseline-note').textContent = ex.baselineReady
        ? `Baseline is the first 3 sessions, ${ex.sessions} sessions in total`
        : `Baseline forming, ${ex.sessions} of 3 sessions`;
    const tile = (label, cur, chg, unit, goodUp = true) => {
        const good = chg === null || chg === 0 ? null : (goodUp ? chg > 0 : chg < 0);
        tiles.appendChild(el('div', { class: 'strip-item' },
            el('div', { class: 'strip-label' }, label),
            el('div', { class: 'strip-value' }, cur === null ? '–' : `${cur}`, cur !== null && unit ? el('small', {}, unit) : null),
            el('div', { class: `strip-delta ${good === null ? '' : good ? 'good' : 'bad'}` },
                chg === null ? 'No baseline yet' : chg === 0 ? 'No change from baseline' : `${chg > 0 ? '+' : '−'}${Math.abs(chg)}${unit} from baseline`)));
    };
    tile(`Range of motion, ${(METRIC_LABEL[ex.primaryJoint] || ex.primaryJoint).toLowerCase()}`, ex.current.rom, ex.change.rom, '°');
    tile('Movement quality', ex.current.quality, ex.change.quality, '');
    tile('Left–right asymmetry', ex.current.symmetry, ex.change.symmetry, '°', false);
    tile('Reported pain', ex.current.pain, ex.change.pain, '', false);

    const labels = ex.timeline.map(t => new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    const joints = [...new Set(ex.timeline.flatMap(t => Object.keys(t.romByJoint)))];
    lineChart($('rom-chart'), labels, joints.map((j, i) => ({ label: METRIC_LABEL[j] || j, data: ex.timeline.map(t => t.romByJoint[j] ?? null), color: COLORS[i % COLORS.length] })), { yTitle: 'degrees' });
    lineChart($('quality-chart'), labels, [
        { label: 'Quality', data: ex.timeline.map(t => t.quality), color: SERIES.primary },
        { label: 'Consistency (%)', data: ex.timeline.map(t => t.consistency), color: SERIES.blue },
        { label: 'Asymmetry (°)', data: ex.timeline.map(t => t.symmetry), color: SERIES.amber },
        { label: 'Pain', data: ex.timeline.map(t => t.pain), color: SERIES.red, axis: 'y2', dashed: true },
    ], { yTitle: 'score', y2Title: 'pain', y2Max: 10 });
}

// ------------------------------------------------------------------ sessions
function renderSessions() {
    const list = $('session-list');
    list.replaceChildren();
    if (!selected.sessions.length) { list.appendChild(el('div', { class: 'empty' }, el('h3', {}, 'No sessions yet'), 'Sessions appear here as soon as the patient completes an exercise.')); return; }
    for (const s of selected.sessions) {
        const sm = s.summary || {};
        const [statusText, statusKind] = s.emergencyStop ? ['Stop pressed', 'danger'] : (STATUS[s.status] || [s.status, '']);
        const details = el('div', { class: 'session-detail hidden' });
        const summaryBtn = el('button', { class: 'session-summary', type: 'button', 'aria-expanded': 'false', onclick: () => {
            const open = details.classList.toggle('hidden') === false;
            summaryBtn.setAttribute('aria-expanded', String(open));
        } },
            el('span', { class: 'ex-icon' }, exerciseIcon(resolveExercise(s.exerciseId))),
            el('span', { class: 'grow' },
                el('span', { class: 'strong block' }, s.exercise),
                el('span', { class: 'tiny muted block' }, fmtDateTime(s.startedAt))),
            el('span', { class: 'meta' },
                el('span', {}, el('b', {}, `${s.validReps}/${(s.targetSets || 0) * (s.targetReps || 0)}`), ' reps'),
                el('span', {}, 'quality ', el('b', {}, sm.avgQuality ?? '–')),
                s.feedback ? el('span', {}, 'pain ', el('b', {}, `${s.feedback.pain}/10`)) : null),
            el('span', { class: `badge ${statusKind}` }, statusText));

        const rom = Object.entries(sm.rom || {}).map(([k, v]) => `${METRIC_LABEL[k] || k} ${v.bestRange}°`).join(', ');
        details.append(
            el('div', { class: 'meta' },
                el('span', {}, 'Best range: ', el('b', {}, rom || 'n/a')),
                el('span', {}, 'Consistency ', el('b', {}, `${sm.consistency ?? '–'}%`)),
                el('span', {}, 'Tracking lost ', el('b', {}, `${sm.lowConfidencePct ?? 0}%`)),
                el('span', {}, el('b', {}, sm.fps ?? '–'), ' fps'),
                el('span', {}, 'Reference ', el('b', {}, sm.templateSource || '–')),
                sm.mlModel ? el('span', {}, 'Model ', el('b', {}, sm.mlModel)) : null,
                s.feedback ? el('span', {}, 'Difficulty ', el('b', {}, s.feedback.difficulty)) : null),
            sm.performanceDecline ? el('p', { class: 'banner warning small' }, 'Movement quality declined during this session (experimental indicator).') : null,
            s.feedback?.notes ? el('p', { class: 'small' }, `Patient's note: "${s.feedback.notes}"`) : null,
            repTable(s),
            reviewBox(s));
        list.appendChild(el('div', { class: 'session-card' }, summaryBtn, details));
    }
}

function repTable(s) {
    const cfg = resolveExercise(s.exerciseId);
    if (!(s.reps || []).length) return el('p', { class: 'small muted' }, 'No per-repetition data for this session.');
    const labels = { correct: ['Good form', 'success'], incorrect: ['Needs correction', 'warning'], incomplete: ['Partial', ''] };
    const rows = s.reps.map(r => el('tr', {},
        el('td', {}, r.index),
        el('td', {}, el('span', { class: `badge ${labels[r.label]?.[1] || ''}` }, labels[r.label]?.[0] || r.label)),
        el('td', {}, Math.round(r.quality)),
        el('td', {}, `${(r.durationMs / 1000).toFixed(1)} s`),
        el('td', {}, r.ml ? `${r.ml.quality} (${Math.round(r.ml.qualityProb * 100)}%)` : '–'),
        el('td', {}, (r.errors || []).map(e => cfg?.rules.find(x => x.id === e.id)?.message || e.id).join('; ') || '–')));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ...['Rep', 'Result', 'Quality', 'Duration', 'AI model', 'Deviations'].map(h => el('th', {}, h)))),
        el('tbody', {}, ...rows)));
}

function reviewBox(s) {
    if (s.review) return el('div', { class: 'banner success small' }, icon('check'), el('p', {}, `Your review: ${s.review.text}`));
    const input = el('input', { class: 'input', placeholder: 'Add a clinical note for this session', maxlength: '2000', 'aria-label': 'Clinical note' });
    const btn = el('button', { class: 'btn btn-secondary', type: 'button', onclick: async () => {
        if (!input.value.trim()) return;
        try { await addSessionReview(selected.patient.uid, s.id, input.value.trim()); s.review = { text: input.value.trim() }; renderSessions(); toast('Note saved', 'success'); }
        catch (e) { toast(e.message, 'error'); }
    } }, 'Save note');
    return el('div', { class: 'row' }, input, btn);
}

// ------------------------------------------------------------------ prescriptions
function renderPrescriptions() {
    const list = $('rx-list');
    list.replaceChildren();
    if (!selected.prescriptions.length) { list.appendChild(el('div', { class: 'empty small' }, 'No active prescriptions. Assign one with the form.')); return; }
    const ul = el('ul', { class: 'list' });
    for (const rx of selected.prescriptions) {
        const cfg = resolveExercise(rx.exerciseId || rx.exercise);
        const sets = el('input', { type: 'number', min: '1', max: '20', value: rx.sets, class: 'input input-num', 'aria-label': 'Sets' });
        const reps = el('input', { type: 'number', min: '1', max: '100', value: rx.reps, class: 'input input-num', 'aria-label': 'Repetitions per set' });
        ul.appendChild(el('li', { class: 'list-item list-item-top' },
            el('span', { class: 'ex-icon' }, exerciseIcon(cfg)),
            el('div', { class: 'grow stack' },
                el('div', {},
                    el('h3', {}, cfg?.name || rx.exercise),
                    el('p', { class: 'tiny muted' }, `Assigned ${fmtDate(rx.assignedAt)}`),
                    rx.notes ? el('p', { class: 'small mt-1' }, rx.notes) : null),
                el('div', { class: 'row wrap' }, sets, el('span', { class: 'small muted' }, 'sets of'), reps, el('span', { class: 'small muted' }, 'reps'),
                    el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => editRx(rx, { sets: +sets.value, reps: +reps.value }) }, 'Update'),
                    el('button', { class: 'btn btn-danger-outline btn-sm', type: 'button', onclick: () => { if (confirm(`Cancel ${cfg?.name || rx.exercise}?`)) editRx(rx, { status: 'cancelled' }); } }, 'Cancel prescription')))));
    }
    list.appendChild(ul);
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
    } catch (err) { console.error(err); toast(`Could not assign the exercise: ${err.message}`, 'error'); }
});

// ------------------------------------------------------------------ actions
$('export-pdf-btn').addEventListener('click', () => {
    if (!selected) return;
    if (!window.jspdf) { toast('The PDF tool is still loading. Try again in a moment.', 'error'); return; }
    exportPatientReport(selected.patient, selected.twin, selected.sessions, selected.alerts);
});

$('unlink-btn').addEventListener('click', async () => {
    if (!selected || !confirm(`Discharge ${selected.patient.displayName || selected.patient.email}? You will no longer have access to their records.`)) return;
    try {
        await unlinkPatient(selected.patient.uid);
        selected = null; show('patient-detail', false); show('report-placeholder', true);
        toast('Patient discharged', 'success');
        await refreshPatients();
    } catch (e) { toast(e.message, 'error'); }
});

// ------------------------------------------------------------------ chat
$('open-chat-btn').addEventListener('click', () => {
    if (!selected) return;
    $('chat-patient-name').textContent = selected.patient.displayName || selected.patient.email;
    show('chat-modal', true);
    $('chat-input').focus();
    chatUnsub?.();
    chatUnsub = subscribeToChat(selected.patient.uid, msgs => renderChat($('chat-messages'), msgs, user.uid), e => toast(e.message, 'error'));
});
function closeChat() { show('chat-modal', false); chatUnsub?.(); chatUnsub = null; }
$('close-chat-btn').addEventListener('click', closeChat);
$('send-msg-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
    const text = $('chat-input').value.trim();
    if (!text || !selected) return;
    try { await sendMessage(selected.patient.uid, profile, text); $('chat-input').value = ''; }
    catch (e) { toast(`Message not sent: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ new / invite patient
function openModal(id, focusId) { show(id, true); setTimeout(() => $(focusId)?.focus(), 0); }
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    ['add-patient-modal', 'link-patient-modal'].forEach(id => show(id, false));
    closeChat();
});

$('add-patient-btn').addEventListener('click', () => { $('add-patient-form').reset(); show('add-patient-error', false); openModal('add-patient-modal', 'new-patient-name'); });
$('cancel-add-patient-btn').addEventListener('click', () => show('add-patient-modal', false));
$('add-patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('submit-add-patient-btn');
    btn.disabled = true; btn.textContent = 'Creating account…';
    try {
        await createPatientAccount($('new-patient-email').value, $('new-patient-password').value, user.uid, $('new-patient-name').value.trim());
        show('add-patient-modal', false);
        toast('Patient account created', 'success');
        await refreshPatients();
    } catch (err) {
        $('add-patient-error').textContent = err.code === 'auth/email-already-in-use'
            ? 'This email already has an account. Use "Invite patient" instead.' : `The account could not be created: ${err.message}`;
        show('add-patient-error', true);
    } finally { btn.disabled = false; btn.textContent = 'Create account'; }
});

$('link-patient-btn').addEventListener('click', () => { $('link-patient-form').reset(); show('link-patient-error', false); openModal('link-patient-modal', 'link-patient-email'); });
$('cancel-link-patient-btn').addEventListener('click', () => show('link-patient-modal', false));
$('link-patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await createLinkRequest(profile, $('link-patient-email').value);
        show('link-patient-modal', false);
        toast('Invitation sent. The patient needs to accept it from their dashboard.', 'success', 5000);
        renderPendingLinks();
    } catch (err) {
        $('link-patient-error').textContent = err.message;
        show('link-patient-error', true);
    }
});
