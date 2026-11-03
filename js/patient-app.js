// MediTask - patient dashboard controller.
import { requireRole, logout } from "./services/auth.js";
import {
    getProfile, updateOwnProfile, getPrescriptions, getSessions, saveSession, addSessionFeedback,
    raiseAlert, subscribeToChat, sendMessage, getMyPendingLinkRequests, respondToLinkRequest, newId,
} from "./services/db.js";
import { resolveExercise } from "./rehabilitation/exercise-configs.js";
import { RehabSession } from "./rehabilitation/pose-engine.js";
import { PHASES } from "./rehabilitation/repetition-counter.js";
import { tryLoadClassifier } from "./intelligence/movement-classifier.js";
import { buildTwin } from "./digital-twin/progress-model.js";
import { drawPose } from "./ui/exercise-visualizer.js";
import { barChart, lineChart } from "./ui/charts.js";
import { $, el, show, toast, fmtDate, toDate, renderChat, PHASE_LABEL, METRIC_LABEL } from "./ui/dom.js";

// ------------------------------------------------------------------ state
let user, profile;
let sessions = [];
let twin = null;
let classifier;                 // undefined = not tried, null = unavailable
let current = null;             // { rx, cfg, engine, sessionId, startedAt, finishing }
let pendingRx = null;
let camera = null, pose = null, stream = null, sendT = 0;
let chatUnsub = null;
let lastSaved = null;           // { record, pointsEarned }
let selectedDifficulty = null;

const PENDING_KEY = 'meditask_pending_sessions';

// ------------------------------------------------------------------ boot
(async function init() {
    ({ user, profile } = await requireRole('patient'));
    show('loading-view', false); show('main-content', true);
    $('welcome-line').textContent = `Signed in as ${profile.displayName || profile.email}`;
    updatePointsUI(profile.points || 0);
    show('rewards-card', true);
    $('voice-toggle').checked = !!profile.voiceEnabled;

    if (!profile.consent?.camera) show('consent-modal', true);
    await flushPendingSessions();
    await Promise.all([renderLinkSection(), loadPrescriptions(), loadAnalytics()]);
})();

$('logout-btn').addEventListener('click', async () => { stopCamera(); await logout(); });

// ------------------------------------------------------------------ consent
$('consent-camera').addEventListener('change', e => { $('consent-accept').disabled = !e.target.checked; });
$('consent-accept').addEventListener('click', async () => {
    const consent = { camera: true, version: 1, at: new Date().toISOString() };
    try { await updateOwnProfile(user.uid, { consent }); profile.consent = consent; } catch (e) { console.error(e); }
    show('consent-modal', false);
});

// ------------------------------------------------------------------ doctor link
async function renderLinkSection() {
    const box = $('link-section');
    box.replaceChildren();
    let requests = [];
    try { requests = await getMyPendingLinkRequests(profile.email); } catch (e) { console.warn('link requests', e); }

    for (const r of requests) {
        const reassign = profile.doctorId && profile.doctorId !== r.doctorId;
        box.appendChild(el('div', { class: 'glass-strong rounded-2xl p-4 border border-indigo-500/40 flex flex-col sm:flex-row gap-3 sm:items-center justify-between' },
            el('div', {},
                el('p', { class: 'font-semibold' }, `🔗 ${r.doctorName || r.doctorEmail} wants to supervise your rehabilitation.`),
                el('p', { class: 'text-xs text-gray-400' }, reassign
                    ? 'Accepting will replace your current physiotherapist. They will be able to see your exercise sessions and messages.'
                    : 'Accepting lets them prescribe exercises and see your session results and messages.')),
            el('div', { class: 'flex gap-2' },
                el('button', { class: 'bg-teal-500 text-black font-bold px-4 py-2 rounded-lg', onclick: () => respond(r, true) }, 'Accept'),
                el('button', { class: 'glass px-4 py-2 rounded-lg', onclick: () => respond(r, false) }, 'Decline'))));
    }

    if (!profile.doctorId) {
        box.appendChild(el('div', { class: 'glass rounded-2xl p-4 border border-amber-500/30 text-sm text-amber-200' },
            'You are not linked to a physiotherapist yet. Ask them to send an invitation to ', el('b', {}, profile.email), '.'));
    } else {
        try {
            const dr = await getProfile(profile.doctorId);
            if (dr) box.appendChild(el('p', { class: 'text-sm text-gray-400' }, `Supervising physiotherapist: ${dr.displayName || dr.email}`));
        } catch (e) { /* profile read is best-effort */ }
    }
}

async function respond(request, accept) {
    try {
        await respondToLinkRequest(user.uid, request, accept);
        if (accept) profile.doctorId = request.doctorId;
        toast(accept ? 'Linked to your physiotherapist' : 'Invitation declined', 'success');
        await Promise.all([renderLinkSection(), loadPrescriptions()]);
    } catch (e) { console.error(e); toast(`Could not update invitation: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ prescriptions
async function loadPrescriptions() {
    const list = $('prescription-list');
    list.replaceChildren();
    $('prescription-loading').textContent = 'Loading...';
    let items = [];
    try { items = await getPrescriptions(user.uid, 'active'); }
    catch (err) {
        console.error('Prescription load error:', err);
        $('prescription-loading').textContent = `Failed to load: ${err.message}`;
        return;
    }
    // No demo/sample fallback: only real prescriptions are ever shown to patients.
    if (!items.length) {
        $('prescription-loading').textContent = '';
        list.appendChild(el('div', { class: 'glass rounded-xl p-6 text-center text-gray-400' },
            profile.doctorId ? 'No active prescriptions. Your physiotherapist will assign exercises here.'
                : 'Once you are linked to a physiotherapist, your prescribed exercises will appear here.'));
        return;
    }
    $('prescription-loading').textContent = `${items.length} active`;
    for (const rx of items) {
        const cfg = resolveExercise(rx.exerciseId || rx.exercise);
        list.appendChild(el('div', { class: 'bg-gray-700/70 p-4 rounded-xl border border-gray-600 hover:border-teal-500 transition-colors flex justify-between items-start gap-3' },
            el('div', {},
                el('h4', { class: 'font-semibold text-lg' }, `${cfg?.emoji || '🏃'} ${cfg?.name || rx.exercise}`),
                el('p', { class: 'text-gray-400' }, `${rx.sets} sets × ${rx.reps} reps`),
                rx.notes ? el('p', { class: 'text-sm text-amber-200 mt-1' }, `Note: ${rx.notes}`) : null,
                el('p', { class: 'text-xs text-gray-500 mt-1' }, `Assigned ${fmtDate(rx.assignedAt)}`)),
            cfg ? el('button', { class: 'bg-teal-500 hover:bg-teal-600 text-black font-bold py-2 px-4 rounded-lg', onclick: () => showDemo(rx, cfg) }, 'Start')
                : el('span', { class: 'text-xs text-red-300' }, 'Exercise not supported in this version')));
    }
}

function showDemo(rx, cfg) {
    if (!profile.consent?.camera) { show('consent-modal', true); return; }
    pendingRx = { rx, cfg };
    $('demo-title').textContent = cfg.name;
    $('demo-animation').textContent = cfg.emoji;
    $('demo-instructions').replaceChildren(...cfg.steps.map(s => el('li', {}, s)));
    $('demo-notes').textContent = rx.notes ? `Physiotherapist's note: ${rx.notes}` : '';
    show('demo-modal', true);
}
$('cancel-demo-btn').addEventListener('click', () => { show('demo-modal', false); pendingRx = null; });
$('start-exercise-btn').addEventListener('click', () => { show('demo-modal', false); if (pendingRx) startSession(pendingRx.rx, pendingRx.cfg); });

// ------------------------------------------------------------------ session
async function loadTemplate(exerciseId) {
    try {
        const r = await fetch(`./models/templates/${exerciseId}.json`, { cache: 'no-cache' });
        if (!r.ok) return null;
        const t = await r.json();
        return Array.isArray(t.progress) && t.progress.length >= 10 ? t : null;
    } catch { return null; }
}

async function startSession(rx, cfg) {
    if (classifier === undefined) classifier = await tryLoadClassifier('./models/web/meditask_model');
    const template = await loadTemplate(cfg.id);
    $('ml-badge').textContent = classifier ? `AI model: ${classifier.info.model_name}` : 'Rule-based analysis';

    const engine = new RehabSession({
        exercise: cfg, sets: rx.sets, reps: rx.reps,
        template: template?.progress, templateSource: template?.source,
        classifier, voice: $('voice-toggle').checked,
        onFrame: onEngineFrame, onRep: onEngineRep, onEvent: onEngineEvent,
    });
    current = { rx, cfg, engine, sessionId: newId(), startedAt: new Date(), finishing: false };

    $('current-exercise-title').textContent = cfg.name;
    $('total-sets').textContent = rx.sets; $('target-reps').textContent = rx.reps;
    $('current-set').textContent = 1; $('current-reps').textContent = 0;
    $('rep-log').replaceChildren(); $('incomplete-note').textContent = '';
    $('phase-steps').replaceChildren(...PHASES.map(p => el('span', { class: 'phase-step', dataset: { phase: p } }, PHASE_LABEL[p])));
    updateProgressUI();
    show('prescription-list-view', false); show('exercise-session-view', true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await startCamera();
}

async function startCamera() {
    const video = $('webcam'), canvas = $('pose-canvas');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false });
    } catch (err) {
        setFeedback(err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in your browser settings to use guided exercises.'
            : `Camera unavailable: ${err.message}`, 'error');
        return;
    }
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    pose = new Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}` });
    pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    pose.onResults(results => {
        if (!current || current.finishing) return;
        const now = performance.now();
        current.engine.processResults(results, now, now - sendT);
    });
    camera = new Camera(video, {
        onFrame: async () => { if (pose && video.readyState >= 2) { sendT = performance.now(); await pose.send({ image: video }); } },
        width: 1280, height: 720,
    });
    camera.start();
    setFeedback('Get into the starting position', 'info');
}

function stopCamera() {
    try { camera?.stop(); } catch { /* ignore */ }
    stream?.getTracks().forEach(t => t.stop());
    const v = $('webcam'); if (v) v.srcObject = null;
    try { pose?.close(); } catch { /* ignore */ }
    camera = null; pose = null; stream = null;
    current?.engine?.feedback?.cancel();
}

let frameCount = 0, fpsT0 = performance.now();
function onEngineFrame(state) {
    const canvas = $('pose-canvas');
    drawPose(canvas.getContext('2d'), canvas, state, current.cfg);

    frameCount++;
    const now = performance.now();
    if (now - fpsT0 > 1000) { $('fps-label').textContent = `${Math.round(frameCount * 1000 / (now - fpsT0))} fps`; frameCount = 0; fpsT0 = now; }

    $('confidence-bar').style.width = `${Math.round((state.confidence || 0) * 100)}%`;
    $('confidence-bar').className = `h-2 transition-all ${state.valid ? 'bg-teal-500' : 'bg-red-500'}`;
    setFeedback(state.message.text, state.message.level);
    updateGauge(state.valid ? state.formScore : 0);

    $('phase-badge').textContent = state.valid ? PHASE_LABEL[state.phase] : 'Paused - repositioning';
    document.querySelectorAll('#phase-steps .phase-step').forEach(n => n.classList.toggle('active', n.dataset.phase === state.phase));

    const cfg = current.cfg;
    if (state.valid && state.metrics) {
        const v = state.metrics[cfg.primaryMetric];
        $('angle-readout').textContent = `${METRIC_LABEL[cfg.primaryMetric] || cfg.primaryMetric}: ${Math.round(v)}° (target ${cfg.targetValue}°)`;
        $('rom-bar').style.width = `${Math.max(0, Math.min(100, state.progress * 100))}%`;
    }
}

function onEngineRep(rep) {
    const e = current.engine;
    $('current-set').textContent = e.currentSet;
    $('current-reps').textContent = e.repsInSet;
    updateProgressUI();
    const incompletes = e.reps.filter(r => r.label === 'incomplete').length;
    $('incomplete-note').textContent = incompletes ? `${incompletes} incomplete repetition(s) not counted - reach the full range to count a rep.` : '';

    const color = rep.label === 'correct' ? 'text-green-400' : rep.label === 'incorrect' ? 'text-yellow-300' : 'text-gray-400';
    const icon = rep.label === 'correct' ? '✅' : rep.label === 'incorrect' ? '⚠️' : '↩️';
    const tip = rep.messages[0] ? ` - ${rep.messages[0]}` : '';
    const ml = rep.ml?.confident ? ` · AI: ${rep.ml.quality}` : '';
    $('rep-log').prepend(el('li', { class: `glass rounded-lg px-3 py-1.5 ${color}` },
        `${icon} Rep ${rep.index} · quality ${Math.round(rep.quality)}${ml}${tip}`));
    if (rep.ml?.exerciseMismatch) toast(`This movement doesn't look like ${current.cfg.name}. Check the instructions.`, 'info');

    if (rep.label !== 'incomplete') {
        const f = $('rep-flash'); f.textContent = e.repsInSet; show(f, true);
        setTimeout(() => show(f, false), 500);
    }
}

function onEngineEvent(ev) {
    if (ev.type === 'set_complete') toast(`Set ${ev.set} complete - rest for a moment, then continue`, 'success');
    if (ev.type === 'rep_aborted') setFeedback('Tracking lost - that repetition was not counted', 'warn');
    if (ev.type === 'session_complete') finishSession('completed');
}

$('voice-toggle').addEventListener('change', e => {
    current?.engine?.setVoice(e.target.checked);
    updateOwnProfile(user.uid, { voiceEnabled: e.target.checked }).catch(() => {});
});

$('back-to-prescriptions').addEventListener('click', () => {
    if (!current) return backToList();
    if (current.engine.reps.length === 0) { stopCamera(); current = null; return backToList(); }
    if (confirm('End this session now? Your completed repetitions will be saved, but the prescription will stay open.')) finishSession('stopped');
});

$('emergency-stop-btn').addEventListener('click', () => {
    if (!current) return;
    finishSession('stopped', { emergency: true });
});

async function finishSession(status, { emergency = false } = {}) {
    if (!current || current.finishing) return;          // duplicate-completion guard
    current.finishing = true;
    stopCamera();
    const { engine, rx, sessionId, startedAt } = current;
    const record = engine.buildRecord({ id: sessionId, status, prescription: rx, startedAt, endedAt: new Date() });
    if (emergency) record.emergencyStop = true;

    let pointsEarned = 0;
    try {
        ({ pointsEarned } = await saveWithRetry(record, rx));
        if (pointsEarned) { profile.points = (profile.points || 0) + pointsEarned; profile.lastRewardedPrescription = rx.id; updatePointsUI(profile.points); }
    } catch (e) {
        console.error('Session save failed, queued for retry:', e);
        queuePending(record, rx);
        toast('Saved on this device - it will upload when you are back online.', 'info', 5000);
    }
    if (emergency) {
        raiseAlert(user.uid, 'emergency_stop', `Patient pressed STOP during ${engine.cfg.name}`, sessionId).catch(console.error);
    }
    lastSaved = { record, pointsEarned, emergency };
    showReport(record, pointsEarned, emergency);
}

async function saveWithRetry(record, rx, attempts = 3) {
    let err;
    for (let i = 0; i < attempts; i++) {
        try {
            // The points rule needs the exact stored value, so refresh first.
            const fresh = await getProfile(user.uid);
            if (fresh) Object.assign(profile, fresh);
            return await saveSession(profile, record, rx);
        } catch (e) {
            err = e;
            if (e.code === 'permission-denied') {
                // e.g. prescription was cancelled/edited meanwhile: save the session on its own.
                try { return await saveSession(profile, record, null); }
                catch (e2) {
                    // Same client-generated id: a rejection here means the record already exists.
                    if (e2.code === 'permission-denied') return { pointsEarned: 0, alreadySaved: true };
                    err = e2;
                }
            }
            await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw err;
}

function queuePending(record, rx) {
    try {
        const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
        q.push({ record: { ...record, startedAt: record.startedAt.toISOString(), endedAt: record.endedAt.toISOString() }, rx });
        localStorage.setItem(PENDING_KEY, JSON.stringify(q.slice(-10)));
    } catch { /* storage unavailable */ }
}

async function flushPendingSessions() {
    let q = [];
    try { q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return; }
    if (!q.length) return;
    const left = [];
    for (const item of q) {
        const rec = { ...item.record, startedAt: new Date(item.record.startedAt), endedAt: new Date(item.record.endedAt) };
        try { await saveSession(profile, rec, item.rx); }
        catch (e) { if (e.code !== 'permission-denied') left.push(item); }
    }
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(left)); } catch { /* ignore */ }
    if (q.length !== left.length) toast(`Uploaded ${q.length - left.length} saved session(s)`, 'success');
}

// ------------------------------------------------------------------ report + feedback
function showReport(rec, points, emergency) {
    const s = rec.summary;
    $('report-title').textContent = emergency ? 'Session stopped' : rec.status === 'completed' ? '🎉 Exercise complete!' : 'Session saved';
    $('report-sub').textContent = `${rec.exercise} · ${rec.validReps}/${rec.targetSets * rec.targetReps} repetitions`;
    const body = $('report-body');
    body.replaceChildren();
    if (emergency) body.appendChild(el('div', { class: 'bg-red-900/50 border border-red-500 rounded-xl p-3 text-sm' },
        'Your physiotherapist has been notified. Rest, and do not continue this exercise until you have spoken to them. If you have severe pain, chest pain or difficulty breathing, call 112.'));

    const tiles = [
        ['Movement quality', s.avgQuality ? `${Math.round(s.avgQuality)}/100` : '--'],
        ['Correct reps', `${s.correctReps}/${s.totalReps}`],
        ['Consistency', `${Math.round(s.consistency)}%`],
        ['Points earned', points ? `+${points}` : '0'],
    ];
    body.appendChild(el('div', { class: 'grid grid-cols-2 gap-3' }, ...tiles.map(([k, v]) =>
        el('div', { class: 'glass rounded-xl p-3 text-center' }, el('p', { class: 'text-xs text-gray-400' }, k), el('p', { class: 'text-xl font-bold text-teal-300' }, v)))));

    const rom = Object.entries(s.rom || {});
    if (rom.length) body.appendChild(el('div', { class: 'glass rounded-xl p-3' },
        el('p', { class: 'text-sm font-semibold mb-2' }, 'Range of motion achieved'),
        ...rom.map(([k, v]) => el('p', { class: 'text-sm text-gray-300' }, `${METRIC_LABEL[k] || k}: best ${v.bestRange}° (avg ${v.meanRange}°)`))));

    const errs = Object.entries(s.errorCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (errs.length) {
        body.appendChild(el('div', { class: 'glass rounded-xl p-3' },
            el('p', { class: 'text-sm font-semibold mb-2' }, 'Focus for next time'),
            ...errs.map(([id, n]) => el('p', { class: 'text-sm text-amber-200' }, `• ${messageFor(id)} (${n} rep${n > 1 ? 's' : ''})`))));
    }
    if (s.performanceDecline) body.appendChild(el('p', { class: 'text-xs text-gray-400' },
        'Your movement quality dropped towards the end of the session. Take adequate rest between sets.'));
    show('report-modal', true);
}

function messageFor(id) {
    const r = current?.cfg?.rules.find(x => x.id === id);
    return r?.message || { too_fast: 'Move more slowly', too_slow: 'Keep a steady pace', short_hold: 'Hold the end position longer', incomplete_rom: 'Reach the full range' }[id] || id;
}

$('report-continue').addEventListener('click', () => {
    show('report-modal', false);
    $('pain-slider').value = 0; $('pain-value').textContent = '0'; $('feedback-notes').value = '';
    show('pain-warning', false);
    selectedDifficulty = null;
    document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('border-teal-500', 'bg-teal-500/20'));
    show('feedback-modal', true);
});

$('pain-slider').addEventListener('input', e => { $('pain-value').textContent = e.target.value; show('pain-warning', +e.target.value >= 7); });
document.querySelectorAll('.difficulty-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('border-teal-500', 'bg-teal-500/20'));
    btn.classList.add('border-teal-500', 'bg-teal-500/20');
    selectedDifficulty = btn.dataset.difficulty;
}));

$('submit-feedback-btn').addEventListener('click', async () => {
    if (!selectedDifficulty) { toast('Please choose a difficulty level', 'error'); return; }
    const pain = parseInt($('pain-slider').value, 10);
    const { record } = lastSaved || {};
    if (record) {
        // Pain escalation relative to the patient's own baseline for this exercise.
        const base = twin?.exercises?.[record.exerciseId]?.baseline?.pain;
        const flags = { highPain: pain >= 7, painIncrease: Number.isFinite(base) && pain - base >= 3 };
        try {
            await addSessionFeedback(user.uid, record.id, { pain, difficulty: selectedDifficulty, notes: $('feedback-notes').value.trim() }, flags);
            if (flags.highPain) await raiseAlert(user.uid, 'pain', `Pain ${pain}/10 reported after ${record.exercise}`, record.id);
            else if (flags.painIncrease) await raiseAlert(user.uid, 'pain_increase', `Pain ${pain}/10 after ${record.exercise} (baseline ${base})`, record.id);
        } catch (e) { console.error('Feedback save failed:', e); toast('Could not save feedback', 'error'); }
    }
    closeSessionFlow();
});
$('skip-feedback-btn').addEventListener('click', closeSessionFlow);

function closeSessionFlow() {
    show('feedback-modal', false);
    current = null; lastSaved = null;
    backToList();
}

async function backToList() {
    show('exercise-session-view', false); show('prescription-list-view', true);
    await Promise.all([loadPrescriptions(), loadAnalytics()]);
}

// ------------------------------------------------------------------ live UI helpers
function setFeedback(text, level = 'info') {
    const cls = { error: 'bg-red-900/70 text-red-100', warn: 'bg-yellow-900/70 text-yellow-100', good: 'bg-green-900/70 text-green-100', info: 'bg-slate-800/80 text-slate-100' }[level] || '';
    const box = $('feedback-box');
    box.className = `text-center text-lg font-bold p-4 rounded-xl transition-all border border-gray-700 ${cls}`;
    box.textContent = text;
}

function updateGauge(score) {
    const ring = $('accuracy-ring');
    ring.style.strokeDashoffset = 283 - 283 * score / 100;
    ring.style.stroke = score >= 80 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444';
    $('accuracy-percent').textContent = Math.round(score);
}

function updateProgressUI() {
    if (!current) return;
    const total = current.rx.sets * current.rx.reps;
    $('progress-bar').style.width = `${Math.min(100, 100 * current.engine.validReps / total)}%`;
}

function updatePointsUI(points) {
    $('user-points').textContent = points;
    $('user-currency').textContent = `₹${(points / 100).toFixed(2)}`;
}

// ------------------------------------------------------------------ analytics / twin
async function loadAnalytics() {
    try { sessions = await getSessions(user.uid, 100); } catch (e) { console.error('sessions', e); sessions = []; }
    twin = buildTwin(sessions);
    const completed = sessions.filter(s => s.status === 'completed');
    $('stat-total-exercises').textContent = completed.length;
    $('stat-adherence').textContent = `${twin.activeDaysLast14}/14`;
    const recentQ = sessions.slice(0, 10).map(s => s.summary?.avgQuality).filter(v => v > 0);
    $('stat-avg-accuracy').textContent = recentQ.length ? Math.round(recentQ.reduce((a, b) => a + b, 0) / recentQ.length) : '--';

    // streak of consecutive days (ending today or yesterday) with a session
    const days = new Set(sessions.map(s => toDate(s.startedAt)?.toDateString()).filter(Boolean));
    let streak = 0; const d = new Date();
    if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
    while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
    $('stat-streak').textContent = streak;

    const labels = [], counts = [];
    for (let i = 6; i >= 0; i--) {
        const day = new Date(); day.setDate(day.getDate() - i);
        labels.push(day.toLocaleDateString('en', { weekday: 'short' }));
        counts.push(sessions.filter(s => toDate(s.startedAt)?.toDateString() === day.toDateString()).length);
    }
    barChart($('weekly-chart'), labels, counts, 'Sessions');

    const sel = $('trend-exercise');
    const exIds = Object.keys(twin.exercises);
    const prev = sel.value;
    sel.replaceChildren(...(exIds.length ? exIds.map(id => el('option', { value: id }, twin.exercises[id].name)) : [el('option', { value: '' }, 'No sessions yet')]));
    if (exIds.includes(prev)) sel.value = prev;
    renderTrend();
}

$('trend-exercise').addEventListener('change', renderTrend);

function renderTrend() {
    const ex = twin?.exercises?.[$('trend-exercise').value];
    if (!ex) { lineChart($('trend-chart'), [], []); $('trend-summary').textContent = 'Complete a session to start tracking your recovery.'; return; }
    const labels = ex.timeline.map(t => new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    lineChart($('trend-chart'), labels, [
        { label: `ROM (${METRIC_LABEL[ex.primaryJoint] || 'primary'}) °`, data: ex.timeline.map(t => t.rom), color: '#22d3ee' },
        { label: 'Quality', data: ex.timeline.map(t => t.quality), color: '#a78bfa' },
        { label: 'Pain (0-10)', data: ex.timeline.map(t => t.pain), color: '#f87171', axis: 'y2', dashed: true },
    ], { yTitle: 'degrees / score', y2Title: 'pain', y2Max: 10 });
    const c = ex.change;
    $('trend-summary').textContent = ex.baselineReady
        ? `Since your first ${3} sessions: range of motion ${fmtChange(c.rom, '°')}, movement quality ${fmtChange(c.quality, '')}.`
        : `Baseline forming - ${ex.sessions}/3 sessions recorded.`;
}
const fmtChange = (v, unit) => v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}${unit}`;

// ------------------------------------------------------------------ chat
$('chat-toggle-btn').addEventListener('click', () => {
    const modal = $('chat-modal');
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden') && !chatUnsub) {
        chatUnsub = subscribeToChat(user.uid, msgs => renderChat($('chat-messages'), msgs, user.uid),
            e => { console.error(e); $('chat-messages').textContent = 'Chat unavailable.'; });
    }
});
$('close-chat-btn').addEventListener('click', () => show('chat-modal', false));
$('send-msg-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

async function sendChat() {
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (!profile.doctorId) { toast('Link to a physiotherapist to use chat', 'error'); return; }
    try { await sendMessage(user.uid, profile, text); $('chat-input').value = ''; }
    catch (e) { console.error('Chat error:', e); toast(`Message not sent: ${e.message}`, 'error'); }
}

window.addEventListener('beforeunload', stopCamera);
