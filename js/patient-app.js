// MediTask - Patient dashboard controller.
// Signed-in patients only ever see their own real data. Signed-out visitors get a clearly
// labelled demo (no Firebase writes). All user-provided text is rendered with textContent.
import { requireRole, logout } from "./services/auth.js";
import {
    getProfile, updateOwnProfile, getPrescriptions, getSessions, saveSession, addSessionFeedback,
    raiseAlert, subscribeToChat, sendMessage, getMyPendingLinkRequests, respondToLinkRequest, newId,
} from "./services/db.js";
import { resolveExercise } from "./rehabilitation/exercise-configs.js";
import { RehabSession } from "./rehabilitation/pose-engine.js";
import { tryLoadClassifier } from "./intelligence/movement-classifier.js";
import { buildTwin } from "./digital-twin/progress-model.js";
import { drawPose } from "./ui/exercise-visualizer.js";
import { $, el, show, toast, fmtDate, fmtDateTime, toDate, initials, PHASE_LABEL, METRIC_LABEL } from "./ui/dom.js";

// ------------------------------------------------------------------ state
let user, profile;
let isDemo = false;
let prescriptions = [];
let sessions = [];
let twin = buildTwin([]);
let classifier;                       // undefined = not tried yet, null = unavailable
let current = null;                   // { rx, cfg, engine, sessionId, startedAt, finishing }
let pendingRx = null;
let pose = null, stream = null, loopHandle = null, inFlight = false, sendT = 0;
let lastSaved = null;                 // { record, pointsEarned, emergency }
let selectedDifficulty = null;
let selectedPain = 0;
let chatUnsub = null, chatSeen = 0, doctorName = 'your physiotherapist';
const latency = { sum: 0, n: 0, downgraded: false };

const PENDING_KEY = 'meditask_pending_sessions';
const MODEL_URL = './models/web/meditask_model';
const DAY = 864e5;

// ------------------------------------------------------------------ demo data (signed-out preview only)
const DEMO_RX = [
    { id: 'demo-rx-1', exercise: 'Squat', exerciseId: 'squat', sets: 2, reps: 5, notes: 'Keep your heels down and go only as low as is comfortable.', assignedAt: new Date(Date.now() - DAY) },
    { id: 'demo-rx-2', exercise: 'Shoulder Abduction', exerciseId: 'shoulder_abduction', sets: 2, reps: 8, notes: 'Stop at shoulder height.', assignedAt: new Date(Date.now() - 2 * DAY) },
];
function demoSessions() {
    return Array.from({ length: 6 }, (_, i) => ({
        id: `demo-s${i}`, exercise: 'Squat', exerciseId: 'squat', status: 'completed', validReps: 10, targetSets: 2, targetReps: 5,
        startedAt: new Date(Date.now() - (6 - i) * DAY),
        summary: { avgQuality: 72 + 3 * i, consistency: 80 + i, rom: { knee_l: { bestRange: 58 + 4 * i, meanRange: 54 + 4 * i } }, symmetry: {} },
        feedback: { pain: Math.max(1, 4 - Math.floor(i / 2)), difficulty: 'medium' },
    }));
}

// ------------------------------------------------------------------ boot
(async function init() {
    try {
        ({ user, profile } = await requireRole('patient'));
    } catch (e) {
        if (e?.code !== 'signed-out') console.warn(e);
        activateDemo();
    }
    renderHeader();
    buildPainScale();
    wireNavigation();
    if (window.lucide) lucide.createIcons();

    if (!isDemo) {
        if (!profile.consent?.camera) show('consent-modal', true);
        await flushPendingSessions();
    }
    await Promise.all([renderLinkSection(), loadPrescriptions(), loadAnalytics()]);
    if (!isDemo) startChatListener();
})();

function activateDemo() {
    isDemo = true;
    user = { uid: 'demo-patient', email: 'demo.patient@example.com' };
    profile = { uid: 'demo-patient', email: 'demo.patient@example.com', displayName: 'Demo patient', role: 'patient', points: 20, doctorId: 'demo-doctor', consent: { camera: true } };
    doctorName = 'the demo physiotherapist';
    show('demo-banner', true);
    const signupBtn = $('header-signup-btn');
    if (signupBtn) {
        signupBtn.classList.remove('hidden');
        signupBtn.classList.add('flex');
    }
    if (window.lucide) lucide.createIcons();
}

function renderHeader() {
    const name = profile.displayName || profile.email.split('@')[0];
    const h = new Date().getHours();
    $('welcome-line').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('user-name').textContent = name;                      // textContent: names are user-provided
    $('user-avatar').textContent = initials(name);
    updatePointsUI(profile.points || 0);
    $('voice-toggle').checked = !!profile.voiceEnabled;
}

$('logout-btn')?.addEventListener('click', async () => {
    stopCamera();
    if (isDemo) { window.location.href = './index.html'; return; }
    await logout();
});

// ------------------------------------------------------------------ consent
$('consent-camera')?.addEventListener('change', e => { $('consent-accept').disabled = !e.target.checked; });
$('consent-accept')?.addEventListener('click', async () => {
    const consent = { camera: true, version: 1, at: new Date().toISOString() };
    try { await updateOwnProfile(user.uid, { consent }); profile.consent = consent; }
    catch (e) { console.error(e); toast('Consent could not be saved. Check your connection and try again.', 'error'); return; }
    show('consent-modal', false);
});

// ------------------------------------------------------------------ physiotherapist link
async function renderLinkSection() {
    const box = $('link-section');
    box.replaceChildren();
    if (isDemo) {
        $('physio-line').textContent = 'This is a demo with sample data. Sign in to connect with your own physiotherapist.';
        show(box, false);
        return;
    }
    let requests = [];
    try { requests = await getMyPendingLinkRequests(profile.email); } catch (e) { console.warn('link requests', e); }

    for (const r of requests) {
        const reassign = profile.doctorId && profile.doctorId !== r.doctorId;
        box.appendChild(el('div', { class: 'glass-panel rounded-3xl p-4 shadow-glass flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-indigo-200' },
            el('div', { class: 'flex items-center gap-3' },
                el('div', { class: 'w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shrink-0 font-bold text-sm shadow-md' }, initials(r.doctorName || r.doctorEmail)),
                el('div', { class: 'text-xs leading-relaxed text-slate-700' },
                    el('p', { class: 'font-bold text-slate-900 text-sm' }, `Dr. ${r.doctorName || r.doctorEmail}`),
                    el('p', { class: 'text-slate-500 text-[11px]' }, reassign ? 'Invited you to transfer care. Accepting replaces your current doctor.' : 'Invited you to connect for clinical tele-rehabilitation.'))),
            el('div', { class: 'flex items-center gap-2 w-full sm:w-auto' },
                el('button', { class: 'flex-1 sm:flex-none px-4 py-2 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md transition', type: 'button', onclick: () => respond(r, true) }, 'Accept Doctor'),
                el('button', { class: 'px-3 py-2 rounded-2xl glass-chip hover:bg-white text-xs text-slate-600 font-semibold transition', type: 'button', onclick: () => respond(r, false) }, 'Decline'))));
    }

    if (!profile.doctorId) {
        const preferredDr = localStorage.getItem('preferred_doctor_email') || '';
        const shareMsg = `Hi Doctor, I registered on MediTask for tele-rehabilitation monitoring. My patient email is: ${profile.email}. Please add me to your care roster.`;

        const connectCard = el('div', { class: 'glass-panel rounded-3xl p-4 shadow-glass space-y-3 border-amber-200/80 bg-gradient-to-br from-amber-50/40 via-white/50 to-indigo-50/40' },
            el('div', { class: 'flex items-start justify-between gap-2' },
                el('div', { class: 'flex items-center gap-2.5' },
                    el('div', { class: 'w-9 h-9 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-base shrink-0 shadow-sm' }, '🩺'),
                    el('div', {},
                        el('h3', { class: 'text-xs font-bold text-slate-900 uppercase tracking-wider' }, 'Connect with your Physiotherapist'),
                        el('p', { class: 'text-[11px] text-slate-500' }, 'Your doctor customizes your movement protocols and tracks your recovery.'))),
                el('span', { class: 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 shrink-0' }, 'Action Needed')),
            
            el('div', { class: 'p-3 rounded-2xl bg-white/70 border border-white space-y-2' },
                el('div', { class: 'flex items-center justify-between' },
                    el('span', { class: 'text-[11px] font-semibold text-slate-700' }, 'Your Patient Email:'),
                    el('span', { class: 'text-[10px] text-slate-500' }, 'Share with your doctor')),
                el('div', { class: 'flex items-center gap-2' },
                    el('input', { type: 'text', readonly: true, value: profile.email, class: 'flex-1 py-1.5 px-3 rounded-xl bg-slate-100 text-xs text-slate-800 font-mono border-0 outline-none select-all' }),
                    el('button', {
                        type: 'button',
                        class: 'px-3 py-1.5 rounded-xl bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-xs border border-slate-200 transition',
                        onclick: () => {
                            navigator.clipboard?.writeText(profile.email);
                            toast('Patient email copied to clipboard! Share it with your doctor.', 'success');
                        }
                    }, 'Copy'),
                    el('a', {
                        href: `https://wa.me/?text=${encodeURIComponent(shareMsg)}`,
                        target: '_blank',
                        class: 'p-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center shadow-xs transition',
                        title: 'Share via WhatsApp'
                    }, el('span', { class: 'text-xs px-1 font-bold' }, 'WhatsApp')))),

            el('div', { class: 'pt-1 flex flex-col sm:flex-row items-center gap-2' },
                el('input', {
                    id: 'dr-lookup-input',
                    type: 'email',
                    placeholder: 'Enter doctor\'s email (e.g. doctor@clinic.com)',
                    value: preferredDr,
                    class: 'w-full sm:flex-1 py-2 px-3 rounded-xl bg-white/80 text-xs text-slate-800 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500'
                }),
                el('button', {
                    id: 'dr-lookup-btn',
                    type: 'button',
                    class: 'w-full sm:w-auto px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-sm transition shrink-0',
                    onclick: async () => {
                        const drEmail = ($('dr-lookup-input')?.value || '').trim().toLowerCase();
                        if (!drEmail) { toast('Please enter your doctor\'s email address.', 'error'); return; }
                        localStorage.setItem('preferred_doctor_email', drEmail);
                        toast('Checking for incoming invitations from your doctor...', 'info');
                        await renderLinkSection();
                        const updatedRequests = await getMyPendingLinkRequests(profile.email);
                        if (updatedRequests.some(r => r.doctorEmail?.toLowerCase() === drEmail)) {
                            toast('Invitation found! Click Accept to connect.', 'success');
                        } else {
                            toast(`No pending invitation from ${drEmail} yet. Ask your doctor to invite ${profile.email}.`, 'info', 6000);
                        }
                    }
                }, 'Check for Invite'))
        );

        box.appendChild(connectCard);
        $('physio-line').textContent = 'Once your physiotherapist links your account, your prescribed exercises appear here.';
    } else {
        try {
            const dr = await getProfile(profile.doctorId);
            if (dr) doctorName = dr.displayName || dr.email;
        } catch { /* best effort */ }
        $('physio-line').textContent = `Your programme is prescribed and reviewed by ${doctorName}. MediTask checks your movement as you go.`;
        $('chat-doctor-name').textContent = doctorName;
    }
    show(box, box.childElementCount > 0);
}

async function respond(request, accept) {
    try {
        await respondToLinkRequest(user.uid, request, accept);
        if (accept) profile.doctorId = request.doctorId;
        toast(accept ? 'You are now linked to your physiotherapist' : 'Invitation declined', 'success');
        await Promise.all([renderLinkSection(), loadPrescriptions()]);
        if (accept) startChatListener();
    } catch (e) { console.error(e); toast(`The invitation could not be updated: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ prescriptions
async function loadPrescriptions() {
    const list = $('prescription-list');
    list.replaceChildren();
    $('prescription-loading').textContent = 'Loading…';
    if (isDemo) prescriptions = DEMO_RX;
    else {
        try { prescriptions = await getPrescriptions(user.uid, 'active'); }
        catch (err) {
            // Never fall back to sample data for a real patient.
            console.error('Prescription load error:', err);
            prescriptions = [];
            $('prescription-loading').textContent = 'Unavailable';
            list.appendChild(emptyCard('Exercises could not be loaded', 'Check your internet connection and reload the page.'));
            return;
        }
    }
    if (!prescriptions.length) {
        $('prescription-loading').textContent = 'None today';
        list.appendChild(emptyCard(profile.doctorId ? 'Nothing prescribed right now' : 'No programme yet',
            profile.doctorId ? 'New exercises from your physiotherapist will appear here.' : 'Your exercises appear here once a physiotherapist links your account.'));
        return;
    }
    $('prescription-loading').textContent = `${prescriptions.length} to do`;
    for (const rx of prescriptions) list.appendChild(prescriptionCard(rx));
}

function emptyCard(title, text) {
    return el('div', { class: 'glass-panel rounded-3xl p-5 text-center text-xs text-slate-500' },
        el('h4', { class: 'font-bold text-slate-800 text-sm mb-1' }, title), text);
}

function prescriptionCard(rx) {
    const cfg = resolveExercise(rx.exerciseId || rx.exercise);
    const minutes = Math.max(2, Math.round(rx.sets * rx.reps * 4 / 60 + (rx.sets - 1) * 0.75));
    const range = cfg ? `${cfg.restValue}° to ${cfg.targetValue}° at the ${(METRIC_LABEL[cfg.primaryMetric] || 'joint').toLowerCase()}` : 'Guided';
    return el('div', { class: 'glass-panel rounded-3xl p-4 shadow-glass relative overflow-hidden' },
        el('div', { class: 'flex items-start justify-between gap-3' },
            el('div', { class: 'space-y-1 min-w-0' },
                el('div', { class: 'flex items-center gap-2' },
                    el('span', { class: 'px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800 text-[10px] font-bold tracking-wider uppercase' }, cfg?.bodyRegion || 'Rehab'),
                    el('span', { class: 'text-[11px] text-slate-500 font-medium' }, `About ${minutes} min`)),
                el('h3', { class: 'text-base font-bold text-slate-900' }, cfg?.name || rx.exercise),
                el('p', { class: 'text-xs text-slate-600' }, `${rx.sets} ${rx.sets === 1 ? 'set' : 'sets'} × ${rx.reps} reps, range ${range}`),
                rx.notes ? el('p', { class: 'text-[11px] text-indigo-900/80 italic mt-1' }, `“${rx.notes}”`) : null,
                el('p', { class: 'text-[10px] text-slate-400' }, `Assigned ${fmtDate(rx.assignedAt)}`)),
            el('div', { class: 'w-12 h-12 rounded-2xl bg-gradient-to-b from-indigo-100/80 to-purple-100/50 border border-white flex items-center justify-center shadow-inner text-indigo-600 font-bold shrink-0' },
                initials(cfg?.name || rx.exercise))),
        el('div', { class: 'mt-4 pt-3 border-t border-white/50 flex items-center justify-between' },
            el('div', { class: 'flex items-center gap-1.5 text-xs font-semibold text-slate-600' },
                el('span', { class: `w-2 h-2 rounded-full ${cfg ? 'bg-emerald-500' : 'bg-amber-500'}` }),
                el('span', {}, cfg ? 'Camera guidance available' : 'Not supported in this version')),
            cfg ? el('button', {
                class: 'px-4 py-2 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md active:scale-95 transition-all',
                type: 'button', onclick: () => openInstructions(rx, cfg),
            }, el('span', {}, 'Start session'), el('span', { 'aria-hidden': 'true' }, '›')) : null));
}

function openInstructions(rx, cfg) {
    if (!isDemo && !profile.consent?.camera) { show('consent-modal', true); return; }
    pendingRx = { rx, cfg };
    $('demo-title').textContent = cfg.name;
    $('demo-dose').textContent = `${rx.sets} ${rx.sets === 1 ? 'set' : 'sets'} of ${rx.reps} repetitions`;
    $('demo-instructions').replaceChildren(...cfg.steps.map(s => el('li', {}, s)));
    $('demo-notes').textContent = rx.notes ? `From your physiotherapist: ${rx.notes}` : '';
    show('demo-notes', !!rx.notes);
    show('demo-modal', true);
    $('start-exercise-btn').focus();
}
$('cancel-demo-btn')?.addEventListener('click', () => { show('demo-modal', false); pendingRx = null; });
$('start-exercise-btn')?.addEventListener('click', () => { show('demo-modal', false); if (pendingRx) startSession(pendingRx.rx, pendingRx.cfg); });

function startFirstExercise() {
    const rx = prescriptions.find(r => resolveExercise(r.exerciseId || r.exercise));
    if (!rx) { toast(prescriptions.length ? 'None of your exercises supports camera guidance yet' : 'No exercises prescribed yet'); $('section-exercises')?.scrollIntoView({ behavior: 'smooth' }); return; }
    openInstructions(rx, resolveExercise(rx.exerciseId || rx.exercise));
}

// ------------------------------------------------------------------ live session
async function loadTemplate(exerciseId) {
    try {
        const r = await fetch(`./models/templates/${exerciseId}.json`, { cache: 'no-cache' });
        if (!r.ok) return null;
        const t = await r.json();
        return Array.isArray(t.progress) && t.progress.length >= 10 ? t : null;
    } catch { return null; }
}

async function startSession(rx, cfg) {
    if (classifier === undefined) classifier = await tryLoadClassifier(MODEL_URL);
    const template = await loadTemplate(cfg.id);
    const mlActive = classifier?.supports(cfg.id);
    const mlQuality = mlActive && classifier.qualityReliable(cfg.id);
    $('ml-badge').textContent = mlQuality ? 'AI model + rules' : mlActive ? 'Rules + AI exercise check' : 'Rule-based analysis';
    $('ml-badge').title = mlQuality ? `Trained model ${classifier.info.model_name} gives a second opinion on each repetition`
        : mlActive ? 'The trained model checks that you are doing the right exercise; form is judged by the rule engine'
            : 'No trained model covers this exercise yet';

    current = {
        rx, cfg, sessionId: newId(), startedAt: new Date(), finishing: false,
        engine: new RehabSession({
            exercise: cfg, sets: rx.sets, reps: rx.reps,
            template: template?.progress, templateSource: template?.source,
            classifier: mlActive ? classifier : null, voice: $('voice-toggle').checked,
            onFrame: handleFrame, onRep: handleRep, onEvent: handleEngineEvent,
        }),
    };
    latency.sum = 0; latency.n = 0;

    $('current-exercise-title').textContent = cfg.name;
    $('session-sub').textContent = `${rx.sets} ${rx.sets === 1 ? 'set' : 'sets'} of ${rx.reps} repetitions. Follow the instruction under the video.`;
    $('total-sets').textContent = rx.sets; $('target-reps').textContent = rx.reps;
    $('current-set').textContent = 1; $('current-reps').textContent = 0;
    $('accuracy-percent').textContent = 0; $('progress-bar').style.width = '0%'; $('rom-fill').style.height = '0%';
    $('rep-log').replaceChildren(el('p', { class: 'text-slate-400 text-xs italic' }, 'Each repetition and its quality appears here.'));
    $('incomplete-note').textContent = '';
    show('prescription-list-view', false); show('exercise-session-view', true);
    document.body.classList.add('session-live');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await startCamera();
}

async function startCamera() {
    const video = $('webcam'), canvas = $('pose-canvas');
    if (!video || !canvas) return;
    if (!window.Pose) { setFeedback('The movement tracker is still loading. Wait a moment and start again.', 'error'); return; }
    setFeedback('Starting camera…', 'info');
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: false
        });
    } catch (err) {
        setFeedback(err.name === 'NotAllowedError'
            ? 'Camera access is blocked. Allow camera access for this site in your browser settings, then start again.'
            : `The camera could not be started (${err.message}).`, 'error');
        return;
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    const syncDims = () => {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
    };
    if (video.readyState >= 1) syncDims();
    else video.onloadedmetadata = syncDims;

    try { await video.play(); } catch { /* autoplay muted is allowed */ }
    syncDims();

    if (!pose) {
        pose = new window.Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}` });
        pose.onResults(onPoseResults);
    }
    // Lighter model on phones / low-end devices; upgraded paths can still downgrade at runtime.
    const lowEnd = (navigator.hardwareConcurrency || 4) <= 4 || /Android|iPhone|iPad/i.test(navigator.userAgent);
    latency.downgraded = lowEnd;
    pose.setOptions({ modelComplexity: lowEnd ? 0 : 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    setFeedback('Get into the starting position', 'info');
    scheduleNextFrame();
}

// The <video> element displays the camera natively (smooth); pose estimation runs on its own
// schedule, one frame in flight at a time, and the canvas only draws the skeleton overlay.
function scheduleNextFrame() {
    const video = $('webcam');
    if (!current || current.finishing || !stream) return;
    loopHandle = video.requestVideoFrameCallback
        ? { type: 'vfc', id: video.requestVideoFrameCallback(poseTick) }
        : { type: 'raf', id: requestAnimationFrame(poseTick) };
}

async function poseTick() {
    const video = $('webcam');
    if (!current || current.finishing || !pose) return;
    if (!inFlight && video.readyState >= 2 && !document.hidden) {
        const now = performance.now();
        if (now - sendT >= 30) {
            inFlight = true; sendT = now;
            try { await pose.send({ image: video }); }
            catch (err) { console.warn('Pose processing error:', err); }
            finally { inFlight = false; }
        }
    }
    scheduleNextFrame();
}

function onPoseResults(results) {
    if (!current || current.finishing) return;
    const now = performance.now();
    const lat = now - sendT;
    current.engine.processResults(results, now, lat);
    // Adaptive quality: if inference is slow, switch to the lighter pose model once.
    latency.sum += lat; latency.n++;
    if (!latency.downgraded && latency.n >= 45) {
        if (latency.sum / latency.n > 70) {
            latency.downgraded = true;
            pose.setOptions({ modelComplexity: 0 });
            toast('Switched to faster tracking for this device');
        }
        latency.sum = 0; latency.n = 0;
    }
}

function stopCamera() {
    const video = $('webcam');
    if (loopHandle) {
        if (loopHandle.type === 'vfc') video?.cancelVideoFrameCallback?.(loopHandle.id);
        else cancelAnimationFrame(loopHandle.id);
        loopHandle = null;
    }
    inFlight = false;
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    if (video) { video.pause(); video.srcObject = null; }
    const canvas = $('pose-canvas');
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    current?.engine?.feedback?.cancel();
    document.body.classList.remove('session-live');
}

let frameCount = 0, fpsT0 = performance.now(), lastPhase = null;
function handleFrame(state) {
    if (!current || current.finishing) return;
    const canvas = $('pose-canvas'), video = $('webcam');
    drawPose(canvas.getContext('2d'), canvas, state, current.cfg, video);

    frameCount++;
    const now = performance.now();
    if (now - fpsT0 > 1000) { $('fps-label').textContent = `${Math.round(frameCount * 1000 / (now - fpsT0))} fps`; frameCount = 0; fpsT0 = now; }
    $('confidence-bar').style.width = `${Math.round((state.confidence || 0) * 100)}%`;
    $('confidence-bar').className = `h-full rounded-full ${state.valid ? 'bg-emerald-500' : 'bg-rose-500'}`;
    $('phase-badge').textContent = state.valid ? (PHASE_LABEL[state.phase] || state.phase) : 'Paused, adjust your position';
    if (state.valid && state.phase !== lastPhase) {
        lastPhase = state.phase;
        document.querySelectorAll('#phase-steps [data-phase]').forEach(n => n.classList.toggle('text-indigo-700', n.dataset.phase === state.phase));
    }
    if (state.message) setFeedback(state.message);
    $('accuracy-percent').textContent = state.valid ? Math.round(state.formScore) : 0;
    if (state.valid && state.metrics) {
        const v = state.metrics[current.cfg.primaryMetric];
        $('angle-readout').textContent = `${METRIC_LABEL[current.cfg.primaryMetric] || current.cfg.primaryMetric} ${Math.round(v)}°, target ${current.cfg.targetValue}°`;
        $('rom-fill').style.height = `${Math.max(0, Math.min(1, state.progress)) * 100}%`;
    }
}

const FEEDBACK_STYLE = {
    error: 'bg-rose-50 border-rose-200 text-rose-900', warn: 'bg-amber-50 border-amber-200 text-amber-900',
    good: 'bg-emerald-50 border-emerald-200 text-emerald-900', info: 'bg-indigo-50 border-indigo-200 text-indigo-900',
};
let lastFeedback = '';
function setFeedback(text, level = 'info') {
    if (typeof text === 'object' && text !== null) {
        level = text.level || level;
        text = text.text || '';
    }
    if (typeof text !== 'string') text = String(text || '');
    const key = level + text;
    if (key === lastFeedback) return;             // avoid DOM churn at 30 fps
    lastFeedback = key;
    const box = $('feedback-box');
    if (!box) return;
    box.className = `mt-3 p-3 rounded-2xl border text-xs font-semibold flex items-center gap-2 ${FEEDBACK_STYLE[level] || FEEDBACK_STYLE.info}`;
    box.setAttribute('role', 'status');
    box.textContent = text;
}

function handleRep(rep) {
    if (!current || current.finishing) return;
    const e = current.engine;
    $('current-set').textContent = e.currentSet;
    $('current-reps').textContent = e.repsInSet;
    $('progress-bar').style.width = `${Math.min(100, 100 * e.validReps / (current.rx.sets * current.rx.reps))}%`;
    const partial = e.reps.filter(r => r.label === 'incomplete').length;
    $('incomplete-note').textContent = partial ? `${partial} partial ${partial === 1 ? 'rep' : 'reps'} not counted` : '';

    const log = $('rep-log');
    if (log.firstElementChild?.tagName === 'P') log.replaceChildren();
    const tone = rep.label === 'correct' ? 'text-teal-600' : rep.label === 'incorrect' ? 'text-amber-600' : 'text-slate-500';
    const label = { correct: 'Good form', incorrect: 'Needs correction', incomplete: 'Partial, not counted' }[rep.label];
    log.prepend(el('div', { class: 'p-2 rounded-xl glass-chip text-xs mb-1.5' },
        el('div', { class: 'flex items-center justify-between' },
            el('span', { class: 'font-semibold text-slate-800' }, `Rep ${rep.index}`),
            el('span', { class: `font-bold ${tone}` }, `${label}, ${Math.round(rep.quality)}/100`),
            el('span', { class: 'text-[10px] text-slate-500' }, `${(rep.durationMs / 1000).toFixed(1)} s`)),
        rep.messages[0] ? el('p', { class: 'text-[10px] text-slate-500 mt-0.5' }, rep.messages[0]) : null,
        rep.ml?.confident ? el('p', { class: 'text-[10px] text-indigo-700 mt-0.5' }, `AI model: ${rep.ml.quality} (${Math.round(rep.ml.qualityProb * 100)}%)`) : null));
    if (rep.ml?.exerciseMismatch) toast(`This movement does not look like ${current.cfg.name}. Check the instructions.`);

    if (rep.label !== 'incomplete') {
        const flash = $('rep-flash');
        flash.textContent = e.repsInSet;
        show(flash, true);
        setTimeout(() => show(flash, false), 500);
    }
}

function handleEngineEvent(ev) {
    if (ev.type === 'set_complete') toast(`Set ${ev.set} complete. Rest for a moment, then continue.`, 'success');
    else if (ev.type === 'rep_aborted') setFeedback('Tracking was lost, so that repetition was not counted', 'warn');
    else if (ev.type === 'session_complete') finishSession('completed');
}

$('voice-toggle')?.addEventListener('change', e => {
    current?.engine?.setVoice(e.target.checked);
    if (!isDemo) updateOwnProfile(user.uid, { voiceEnabled: e.target.checked }).catch(() => {});
});

$('back-to-prescriptions')?.addEventListener('click', () => {
    if (!current) return backToDashboard();
    if (!current.engine || !current.engine.reps.length) {
        stopCamera();
        current = null;
        return backToDashboard();
    }
    finishSession('stopped');
});

$('emergency-stop-btn')?.addEventListener('click', () => { if (current) finishSession('stopped', { emergency: true }); });

async function finishSession(status, { emergency = false } = {}) {
    if (!current || current.finishing) return;            // duplicate-completion guard
    current.finishing = true;
    stopCamera();
    const { engine, rx, sessionId, startedAt } = current;
    const record = engine.buildRecord({ id: sessionId, status, prescription: rx, startedAt, endedAt: new Date() });
    if (emergency) record.emergencyStop = true;

    // Immediately hide the live session view so UI transitions smoothly
    show('exercise-session-view', false);

    let pointsEarned = 0;
    if (isDemo) {
        pointsEarned = status === 'completed' ? 10 : 0;
        profile.points = (profile.points || 0) + pointsEarned;
        updatePointsUI(profile.points);
        sessions.unshift({ ...record, feedback: null });
        lastSaved = { record, pointsEarned, emergency };
        showReport(record, pointsEarned, emergency);
    } else {
        lastSaved = { record, pointsEarned: 0, emergency };
        showReport(record, 0, emergency);
        saveWithRetry(record, rx).then(({ pointsEarned: pts }) => {
            if (pts) {
                profile.points = (profile.points || 0) + pts;
                profile.lastRewardedPrescription = rx.id;
                updatePointsUI(profile.points);
                if (lastSaved) lastSaved.pointsEarned = pts;
            }
        }).catch(e => {
            console.error('Session save failed, queued for retry:', e);
            queuePending(record, rx);
            toast('Saved on this device. It will upload when you are back online.', 'info', 5000);
        });
        if (emergency) raiseAlert(user.uid, 'emergency_stop', `Patient pressed STOP during ${engine.cfg.name}`, sessionId).catch(console.error);
    }
}

async function saveWithRetry(record, rx, attempts = 3) {
    let err;
    for (let i = 0; i < attempts; i++) {
        try {
            const fresh = await getProfile(user.uid);           // points rule needs the stored value
            if (fresh) Object.assign(profile, fresh);
            return await saveSession(profile, record, rx);
        } catch (e) {
            err = e;
            if (e.code === 'permission-denied') {
                // e.g. prescription edited/cancelled meanwhile: save the session on its own.
                try { return await saveSession(profile, record, null); }
                catch (e2) {
                    if (e2.code === 'permission-denied') return { pointsEarned: 0, alreadySaved: true };   // same id already stored
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
function statTile(label, value, tone = 'text-slate-900') {
    return el('div', {}, el('span', { class: 'text-slate-400 block text-[10px] uppercase font-bold' }, label), el('span', { class: `text-xl font-bold ${tone}` }, value));
}

function showReport(rec, points, emergency) {
    const s = rec.summary;
    $('report-title').textContent = emergency ? 'Session stopped' : rec.status === 'completed' ? 'Session complete' : 'Session saved';
    $('report-sub').textContent = `${rec.exercise}: ${rec.validReps} of ${rec.targetSets * rec.targetReps} repetitions`;
    const parts = [];
    if (emergency) parts.push(el('p', { class: 'text-xs text-rose-800 bg-rose-50 p-2.5 rounded-xl border border-rose-200' },
        isDemo ? 'In the real app your physiotherapist is alerted immediately.' :
            'Your physiotherapist has been alerted. Rest and do not continue this exercise until you have spoken to them. For severe pain, chest pain or difficulty breathing, call 112.'));
    parts.push(el('div', { class: 'p-3 rounded-2xl glass-chip grid grid-cols-2 gap-3 text-center' },
        statTile('Movement quality', s.avgQuality ? `${Math.round(s.avgQuality)}/100` : '–', 'text-teal-600'),
        statTile('Good-form reps', `${s.correctReps} of ${s.totalReps}`),
        statTile('Consistency', `${Math.round(s.consistency)}%`),
        statTile('Points earned', points ? `+${points}` : '0', 'text-amber-500')));
    const rom = Object.entries(s.rom || {});
    if (rom.length) parts.push(el('div', { class: 'p-3 rounded-2xl glass-chip' },
        el('p', { class: 'text-[10px] uppercase font-bold text-slate-400 mb-1' }, 'Range of motion'),
        ...rom.map(([k, v]) => el('p', { class: 'flex justify-between' }, el('span', {}, METRIC_LABEL[k] || k), el('span', { class: 'font-semibold' }, `best ${v.bestRange}°, average ${v.meanRange}°`)))));
    const errs = Object.entries(s.errorCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (errs.length) parts.push(el('div', { class: 'p-3 rounded-2xl glass-chip' },
        el('p', { class: 'text-[10px] uppercase font-bold text-slate-400 mb-1' }, 'Focus on next time'),
        ...errs.map(([id, n]) => el('p', {}, `• ${messageFor(id)} (${n} ${n === 1 ? 'rep' : 'reps'})`))));
    if (s.performanceDecline) parts.push(el('p', { class: 'text-[11px] text-slate-500' }, 'Your movement quality dropped towards the end. Take enough rest between sets.'));
    $('report-body').replaceChildren(...parts);
    show('report-modal', true);
    $('report-continue').focus();
}

function messageFor(id) {
    return current?.cfg?.rules.find(r => r.id === id)?.message
        || { too_fast: 'Move more slowly', too_slow: 'Keep a steady pace', short_hold: 'Hold the end position a little longer', incomplete_rom: 'Reach the full range' }[id] || id;
}

$('report-continue')?.addEventListener('click', () => {
    show('report-modal', false);
    setPain(0); $('feedback-notes').value = '';
    selectedDifficulty = null;
    document.querySelectorAll('.difficulty-btn').forEach(b => { b.classList.remove('bg-indigo-600', 'text-white'); b.setAttribute('aria-pressed', 'false'); });
    show('feedback-modal', true);
});
// Closing the report without feedback still returns to the dashboard.
['close-report-btn', 'return-dashboard-btn'].forEach(id => $(id)?.addEventListener('click', () => { show('report-modal', false); closeSessionFlow(); }));

function buildPainScale() {
    const scale = $('pain-scale');
    scale.replaceChildren(...Array.from({ length: 11 }, (_, i) => el('button', {
        type: 'button', 'aria-label': `Pain ${i}`, 'aria-pressed': 'false', dataset: { pain: i },
        class: 'p-2 rounded-xl glass-chip text-xs font-bold transition text-slate-800', onclick: () => setPain(i),
    }, String(i))));
    setPain(0);
}
function setPain(v) {
    selectedPain = v;
    $('pain-value').textContent = v;
    document.querySelectorAll('#pain-scale button').forEach(b => {
        const on = +b.dataset.pain === v;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('text-white', on);
        b.classList.toggle(v >= 7 ? 'bg-rose-600' : 'bg-indigo-600', on);
        if (!on) b.classList.remove('bg-rose-600', 'bg-indigo-600');
    });
    show('pain-warning', v >= 7);
}

document.querySelectorAll('.difficulty-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.difficulty-btn').forEach(x => { x.classList.remove('bg-indigo-600', 'text-white'); x.setAttribute('aria-pressed', 'false'); });
    b.classList.add('bg-indigo-600', 'text-white'); b.setAttribute('aria-pressed', 'true');
    selectedDifficulty = b.dataset.difficulty;
}));

$('submit-feedback-btn')?.addEventListener('click', async () => {
    if (!selectedDifficulty) { toast('Choose how difficult the exercise felt', 'error'); return; }
    const record = lastSaved?.record;
    const feedback = { pain: selectedPain, difficulty: selectedDifficulty, notes: $('feedback-notes').value.trim() };
    if (record && isDemo) {
        const s = sessions.find(x => x.id === record.id); if (s) s.feedback = feedback;
    } else if (record) {
        // Pain escalation relative to the patient's own baseline for this exercise.
        const base = twin?.exercises?.[record.exerciseId]?.baseline?.pain;
        const flags = { highPain: selectedPain >= 7, painIncrease: Number.isFinite(base) && selectedPain - base >= 3 };
        try {
            await addSessionFeedback(user.uid, record.id, feedback, flags);
            if (flags.highPain) await raiseAlert(user.uid, 'pain', `Pain ${selectedPain}/10 reported after ${record.exercise}`, record.id);
            else if (flags.painIncrease) await raiseAlert(user.uid, 'pain_increase', `Pain ${selectedPain}/10 after ${record.exercise} (baseline ${base})`, record.id);
        } catch (e) {
            console.error('Feedback save failed:', e);
            toast('Feedback could not be saved. Try again with a stable connection.', 'error');
            return;
        }
    }
    toast('Feedback saved', 'success');
    closeSessionFlow();
});
$('skip-feedback-btn')?.addEventListener('click', closeSessionFlow);

function closeSessionFlow() {
    show('feedback-modal', false);
    current = null; lastSaved = null;
    backToDashboard();
}

async function backToDashboard() {
    show('exercise-session-view', false); show('prescription-list-view', true);
    await Promise.all([loadPrescriptions(), loadAnalytics()]);
}

function updatePointsUI(points) {
    $('user-points').textContent = points;
    $('user-currency').textContent = (points / 100).toFixed(2);
}

// ------------------------------------------------------------------ analytics / digital twin
async function loadAnalytics() {
    if (isDemo) { if (!sessions.length) sessions = demoSessions(); }
    else {
        try { sessions = await getSessions(user.uid, 100); }
        catch (e) { console.error('sessions', e); sessions = []; }
    }
    twin = buildTwin(sessions);
    const completed = sessions.filter(s => s.status === 'completed');
    $('stat-total-exercises').textContent = completed.length;

    // Movement quality over the last 10 sessions
    const q = sessions.slice(0, 10).map(s => s.summary?.avgQuality).filter(v => v > 0);
    const avgQ = q.length ? Math.round(q.reduce((a, b) => a + b, 0) / q.length) : null;
    $('stat-avg-accuracy').textContent = avgQ ?? '–';
    $('stat-gauge').setAttribute('stroke-dasharray', `${avgQ ?? 0}, 100`);
    const [badgeText, badgeCls, dotCls] = avgQ === null ? ['No sessions yet', 'bg-slate-50 text-slate-600 border-slate-200', 'bg-slate-300']
        : avgQ >= 80 ? ['Good form', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'bg-emerald-500']
            : avgQ >= 60 ? ['Improving', 'bg-amber-50 text-amber-700 border-amber-200', 'bg-amber-500']
                : ['Needs work', 'bg-rose-50 text-rose-700 border-rose-200', 'bg-rose-500'];
    $('stat-quality-badge').className = `inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold mt-1 ${badgeCls}`;
    $('stat-quality-badge').textContent = badgeText;
    $('stat-quality-dot').className = `w-2 h-2 rounded-full ${dotCls}`;

    // Streak (consecutive days ending today or yesterday) and active days this week
    const days = new Set(sessions.map(s => toDate(s.startedAt)?.toDateString()).filter(Boolean));
    let streak = 0; const d = new Date();
    if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
    while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
    $('stat-streak').textContent = streak;
    const week = [];
    for (let i = 6; i >= 0; i--) { const x = new Date(); x.setDate(x.getDate() - i); week.push(x); }
    const active7 = week.filter(x => days.has(x.toDateString())).length;
    $('stat-adherence').textContent = Math.min(active7, 5);
    $('stat-week-bar').style.width = `${Math.min(100, active7 / 5 * 100)}%`;

    // Programme day chip (since first session)
    const first = sessions.map(s => toDate(s.startedAt)).filter(Boolean).sort((a, b) => a - b)[0];
    if (first) { $('programme-day').textContent = `Day ${Math.floor((Date.now() - first) / DAY) + 1}`; show('programme-day', true); }

    renderWeekly(week);
    const sel = $('trend-exercise');
    const ids = Object.keys(twin.exercises);
    const prev = sel.value;
    sel.replaceChildren(...(ids.length ? ids.map(id => el('option', { value: id }, twin.exercises[id].name)) : [el('option', { value: '' }, 'No sessions yet')]));
    if (ids.includes(prev)) sel.value = prev;
    renderTrend();
}

const CHART_TICKS = { font: { size: 9, family: '"Plus Jakarta Sans"' }, color: '#64748b' };
function chartFor(canvas, config) {
    if (!canvas || !window.Chart) return;
    Chart.getChart(canvas)?.destroy();
    new Chart(canvas, config);
}

function renderWeekly(week) {
    const counts = week.map(x => sessions.filter(s => toDate(s.startedAt)?.toDateString() === x.toDateString()).length);
    chartFor($('weekly-chart'), {
        type: 'bar',
        data: { labels: week.map(x => x.toLocaleDateString('en', { weekday: 'short' })), datasets: [{ data: counts, backgroundColor: 'rgba(79, 70, 229, 0.75)', borderRadius: 6, maxBarThickness: 26 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, plugins: { legend: { display: false } },
            scales: { x: { grid: { display: false }, ticks: CHART_TICKS }, y: { beginAtZero: true, ticks: { ...CHART_TICKS, precision: 0 }, grid: { color: 'rgba(255,255,255,0.5)' } } } },
    });
}

$('trend-exercise')?.addEventListener('change', renderTrend);
function renderTrend() {
    const ex = twin.exercises[$('trend-exercise').value];
    if (!ex) {
        Chart.getChart($('trend-chart'))?.destroy();
        $('trend-summary').textContent = 'Complete a session to start tracking your recovery.';
        return;
    }
    const labels = ex.timeline.map(t => new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    chartFor($('trend-chart'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'Range of motion (°)', data: ex.timeline.map(t => t.rom), borderColor: '#4f46e5', backgroundColor: '#4f46e5', tension: 0.35, borderWidth: 2.5, spanGaps: true, pointRadius: 2 },
            { label: 'Movement quality', data: ex.timeline.map(t => t.quality), borderColor: '#0d9488', backgroundColor: '#0d9488', tension: 0.35, borderWidth: 2, spanGaps: true, pointRadius: 2 },
        ] },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 8, font: { size: 9 } } } },
            scales: { x: { grid: { display: false }, ticks: CHART_TICKS }, y: { beginAtZero: true, ticks: CHART_TICKS, grid: { color: 'rgba(255,255,255,0.5)' } } } },
    });
    const c = ex.change;
    const fmt = (v, u) => v === null ? 'not available yet' : v === 0 ? 'unchanged' : `${v > 0 ? 'up' : 'down'} ${Math.abs(v)}${u}`;
    $('trend-summary').textContent = ex.baselineReady
        ? `Compared with your first three sessions: range of motion ${fmt(c.rom, '°')}, movement quality ${fmt(c.quality, ' points')}.`
        : `Your baseline is still forming (${ex.sessions} of 3 sessions).`;
    $('stat-trend-caption').textContent = ex.baselineReady && c.rom !== null
        ? `${ex.name}: range of motion ${fmt(c.rom, '°')} since baseline` : 'Average of your last 10 sessions';
}

// ------------------------------------------------------------------ chat (Firestore, scoped to this patient)
function startChatListener() {
    if (chatUnsub || !profile.doctorId) return;
    chatUnsub = subscribeToChat(user.uid, msgs => {
        renderMessages(msgs);
        const fromDoctor = msgs.filter(m => m.senderRole === 'doctor').length;
        show('chat-unread-dot', fromDoctor > chatSeen && $('chat-modal').classList.contains('hidden'));
    }, e => console.warn('chat', e));
}

function renderMessages(msgs) {
    const box = $('chat-messages');
    box.replaceChildren();
    if (!msgs.length) {
        box.appendChild(el('p', { class: 'text-center text-xs text-slate-500 py-6' }, `No messages yet. Ask ${doctorName} a question or tell them how your exercises are going.`));
        return;
    }
    for (const m of msgs) {
        const mine = m.senderId === user.uid;
        box.appendChild(el('div', { class: `p-2.5 rounded-2xl max-w-[85%] text-xs ${mine ? 'ml-auto bg-indigo-600 text-white font-medium shadow-sm' : 'mr-auto glass-chip text-slate-800'}` },
            el('p', { class: 'font-semibold text-[10px] opacity-75 mb-0.5' }, mine ? 'You' : (m.senderName || 'Physiotherapist')),
            el('p', { class: 'whitespace-pre-wrap break-words' }, m.text),
            el('p', { class: 'text-[9px] opacity-60 mt-0.5 text-right' }, m.createdAt ? fmtDateTime(m.createdAt) : 'Sending…')));
    }
    box.scrollTop = box.scrollHeight;
    chatSeen = msgs.filter(m => m.senderRole === 'doctor').length;
}

let demoChat = [{ senderId: 'demo-doctor', senderRole: 'doctor', senderName: 'Demo physiotherapist', text: 'Welcome! Message me here if anything feels painful.', createdAt: new Date(Date.now() - 3600e3) }];
function openChat() {
    show('chat-modal', true);
    show('chat-unread-dot', false);
    if (isDemo) renderMessages(demoChat);
    else if (!profile.doctorId) renderMessages([]);
    $('chat-input').focus();
}

async function sendChatMessage() {
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (isDemo) { demoChat = [...demoChat, { senderId: user.uid, senderRole: 'patient', text, createdAt: new Date() }]; renderMessages(demoChat); $('chat-input').value = ''; return; }
    if (!profile.doctorId) { toast('Messages are available once you are linked to a physiotherapist', 'error'); return; }
    try { await sendMessage(user.uid, profile, text); $('chat-input').value = ''; }
    catch (e) { console.error('Chat error:', e); toast(`Message not sent: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ navigation
function wireNavigation() {
    const pills = { 'pill-overview': null, 'pill-exercises': 'section-exercises', 'pill-pose': 'start', 'pill-recovery': 'section-recovery', 'pill-guidance': 'section-guidelines' };
    const setActive = (id) => Object.keys(pills).forEach(pid => {
        const b = $(pid); if (!b) return;
        const on = pid === id;
        b.className = `cat-pill px-3.5 py-1.5 rounded-full text-xs shrink-0 transition ${on ? 'bg-white text-indigo-900 shadow-sm border border-white font-semibold' : 'font-medium text-slate-600 glass-chip hover:bg-white/40'}`;
        b.setAttribute('aria-pressed', String(on));
    });
    Object.entries(pills).forEach(([id, target]) => $(id)?.addEventListener('click', () => {
        if (target === 'start') { startFirstExercise(); return; }
        setActive(id);
        if (target) $(target)?.scrollIntoView({ behavior: 'smooth' }); else window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    $('dock-home')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    $('dock-routines')?.addEventListener('click', () => $('section-exercises')?.scrollIntoView({ behavior: 'smooth' }));
    $('dock-analytics')?.addEventListener('click', () => $('section-recovery')?.scrollIntoView({ behavior: 'smooth' }));
    $('dock-camera-fab')?.addEventListener('click', startFirstExercise);
    $('dock-therapist')?.addEventListener('click', openChat);
    $('chat-toggle-btn')?.addEventListener('click', openChat);
    $('close-chat-btn')?.addEventListener('click', () => show('chat-modal', false));
    $('send-msg-btn')?.addEventListener('click', sendChatMessage);
    $('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { show('chat-modal', false); } });
}

window.addEventListener('pagehide', stopCamera);
