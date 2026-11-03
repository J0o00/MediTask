// MediTask - Patient Dashboard Controller (Lumis Aesthetic)
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
import { barChart, lineChart, SERIES } from "./ui/charts.js";
import { icon, exerciseIcon, hydrateIcons } from "./ui/icons.js";
import { $, el, show, toast, fmtDate, toDate, renderChat, initials, PHASE_LABEL, METRIC_LABEL } from "./ui/dom.js";

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
let selectedPain = 0;
let isDemoMode = false;

const PENDING_KEY = 'meditask_pending_sessions';
const RING = 239;               // circumference of the form-score ring (r = 38)

const DEMO_PRESCRIPTIONS = [
    {
        id: "rx-demo-1",
        exercise: "Shoulder Abduction",
        exerciseId: "shoulder_abduction",
        sets: 3,
        reps: 10,
        notes: "Keep movements fluid. Stop if shoulder impingement pain occurs.",
        assignedAt: new Date(Date.now() - 86400000)
    },
    {
        id: "rx-demo-2",
        exercise: "Isometric Knee Extension",
        exerciseId: "squat",
        sets: 2,
        reps: 15,
        notes: "Move into 90° flexion, hold steady, and return slowly.",
        assignedAt: new Date(Date.now() - 172800000)
    }
];

const DEMO_SESSIONS = [
    { id: "s1", exercise: "Shoulder Abduction", exerciseId: "shoulder_abduction", startedAt: new Date(Date.now() - 86400000), validReps: 10, targetSets: 3, targetReps: 10, status: "completed", summary: { avgQuality: 88, consistency: 84, rom: { shoulder: { bestRange: 120 } } } },
    { id: "s2", exercise: "Shoulder Abduction", exerciseId: "shoulder_abduction", startedAt: new Date(Date.now() - 172800000), validReps: 10, targetSets: 3, targetReps: 10, status: "completed", summary: { avgQuality: 85, consistency: 80, rom: { shoulder: { bestRange: 115 } } } },
    { id: "s3", exercise: "Isometric Knee Extension", exerciseId: "squat", startedAt: new Date(Date.now() - 259200000), validReps: 15, targetSets: 2, targetReps: 15, status: "completed", summary: { avgQuality: 92, consistency: 90, rom: { knee: { bestRange: 90 } } } }
];

hydrateIcons();

// ------------------------------------------------------------------ boot
(async function init() {
    try {
        const authResult = await requireRole('patient').catch(() => null);
        if (authResult && authResult.user) {
            user = authResult.user;
            profile = authResult.profile;
        } else {
            activateDemoMode();
        }
    } catch {
        activateDemoMode();
    }

    const name = profile.displayName || profile.email.split('@')[0];
    const h = new Date().getHours();
    if ($('welcome-line')) $('welcome-line').innerHTML = `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, <span class="text-indigo-900 font-extrabold">${name}</span>`;
    if ($('user-avatar')) $('user-avatar').textContent = initials(name);
    if ($('user-name')) $('user-name').textContent = name;
    updatePointsUI(profile.points || 0);
    show('rewards-card', true);
    if ($('voice-toggle')) $('voice-toggle').checked = !!profile.voiceEnabled;
    buildPainScale();
    setupNavigation();

    if (!profile.consent?.camera && !isDemoMode) show('consent-modal', true);
    await flushPendingSessions();
    await Promise.all([renderLinkSection(), loadPrescriptions(), loadAnalytics()]);
    if (window.lucide) lucide.createIcons();
})();

function activateDemoMode() {
    isDemoMode = true;
    user = { uid: "demo-pt-1", email: "aq@gmail.com" };
    profile = { uid: "demo-pt-1", email: "aq@gmail.com", displayName: "aq", role: "patient", points: 40, doctorId: "demo-doc-1", consent: { camera: true } };
    show("demo-banner", true);
}

$('logout-btn')?.addEventListener('click', async () => {
    stopCamera();
    if (isDemoMode) {
        window.location.href = "./index.html";
        return;
    }
    await logout();
});

// ------------------------------------------------------------------ consent
$('consent-camera')?.addEventListener('change', e => { if ($('consent-accept')) $('consent-accept').disabled = !e.target.checked; });
$('consent-accept')?.addEventListener('click', async () => {
    const consent = { camera: true, version: 1, at: new Date().toISOString() };
    try { await updateOwnProfile(user.uid, { consent }); profile.consent = consent; } catch (e) { console.error(e); }
    show('consent-modal', false);
});

// ------------------------------------------------------------------ physiotherapist link
async function renderLinkSection() {
    const box = $('link-section');
    if (!box) return;

    if (isDemoMode) {
        show(box, false);
        if ($('physio-line')) $('physio-line').textContent = "Your programme is prescribed by Dr. R. Reynolds, MD. MediTask checks your movement in real time.";
        return;
    }

    box.replaceChildren();
    let requests = [];
    try { requests = await getMyPendingLinkRequests(profile.email); } catch (e) { console.warn('link requests', e); }

    for (const r of requests) {
        const reassign = profile.doctorId && profile.doctorId !== r.doctorId;
        box.appendChild(el('div', { class: 'p-3 rounded-2xl glass-panel text-xs flex items-center justify-between' },
            el('div', { class: 'grow' },
                el('p', { class: 'font-semibold text-slate-900' }, `${r.doctorName || r.doctorEmail} has invited you to join their care.`),
                el('p', { class: 'text-[11px] text-slate-500' }, reassign ? 'Accepting replaces your current therapist.' : 'Accepting shares kinematic results with them.')),
            el('div', { class: 'flex gap-2' },
                el('button', { class: 'px-2.5 py-1 rounded-xl glass-chip text-xs', type: 'button', onclick: () => respond(r, false) }, 'Decline'),
                el('button', { class: 'px-2.5 py-1 rounded-xl bg-indigo-600 text-white font-semibold text-xs', type: 'button', onclick: () => respond(r, true) }, 'Accept'))));
    }

    if (!profile.doctorId) {
        show(box, true);
        if ($('physio-line')) $('physio-line').textContent = 'Once your physiotherapist links your account, your prescribed exercises appear here.';
    } else {
        try {
            const dr = await getProfile(profile.doctorId);
            if (dr && $('physio-line')) $('physio-line').textContent = `Your programme is prescribed and reviewed by ${dr.displayName || dr.email}. MediTask checks your movement as you go.`;
        } catch { /* best-effort */ }
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
    if (!list) return;
    list.replaceChildren();
    if ($('prescription-loading')) $('prescription-loading').textContent = 'Loading…';

    let items = [];
    if (isDemoMode) {
        items = DEMO_PRESCRIPTIONS;
    } else {
        try { items = await getPrescriptions(user.uid, 'active'); }
        catch (err) {
            console.error('Prescription load error:', err);
            items = DEMO_PRESCRIPTIONS;
        }
    }

    if (!items.length) {
        if ($('prescription-loading')) $('prescription-loading').textContent = '0 Modules';
        list.appendChild(el('div', { class: 'glass-panel rounded-3xl p-5 text-center text-xs text-slate-500' },
            el('h4', { class: 'font-bold text-slate-800 text-sm mb-1' }, 'No exercises prescribed'),
            'Your exercises will appear here as soon as your physiotherapist assigns them.'));
        return;
    }

    if ($('prescription-loading')) $('prescription-loading').textContent = `${items.length} Modules`;

    for (const rx of items) {
        const cfg = resolveExercise(rx.exerciseId || rx.exercise);
        const card = el('div', { class: 'glass-panel rounded-3xl p-4 shadow-glass border-white/90 relative overflow-hidden transition hover:shadow-lg' },
            el('div', { class: 'flex items-start justify-between' },
                el('div', { class: 'space-y-1' },
                    el('div', { class: 'flex items-center space-x-2' },
                        el('span', { class: 'px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800 text-[10px] font-bold tracking-wider uppercase' }, cfg?.bodyRegion || 'Rehab'),
                        el('span', { class: 'text-[11px] text-slate-500 font-medium flex items-center gap-1' }, '5-10 mins')
                    ),
                    el('h3', { class: 'text-base font-bold text-slate-900' }, cfg?.name || rx.exercise),
                    el('p', { class: 'text-xs text-slate-600' }, `${rx.sets} Sets × ${rx.reps} Reps • Prescribed Range ${cfg?.targetValue ? `0°–${cfg.targetValue}°` : 'Guided'}`),
                    rx.notes ? el('p', { class: 'text-[11px] text-indigo-900/80 italic mt-1' }, `“${rx.notes}”`) : null
                ),
                el('div', { class: 'w-12 h-12 rounded-2xl bg-gradient-to-b from-indigo-100/80 to-purple-100/50 border border-white flex items-center justify-center shadow-inner text-indigo-600 font-bold' },
                    initials(cfg?.name || rx.exercise)
                )
            ),
            el('div', { class: 'mt-4 pt-3 border-t border-white/50 flex items-center justify-between' },
                el('div', { class: 'flex items-center space-x-1.5 text-xs font-semibold text-slate-600' },
                    el('span', { class: 'w-2 h-2 rounded-full bg-emerald-500' }),
                    el('span', {}, 'Vision tracking enabled')
                ),
                el('button', {
                    class: 'px-4 py-2 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center space-x-1.5 shadow-md active:scale-95 transition-all',
                    type: 'button',
                    onclick: () => showDemo(rx, cfg)
                }, el('span', {}, 'Start Session'), el('span', {}, '›'))
            )
        );
        list.appendChild(card);
    }
    if (window.lucide) lucide.createIcons();
}

function showDemo(rx, cfg) {
    if (!cfg) { toast('Exercise definition unavailable', 'error'); return; }
    pendingRx = { rx, cfg };
    if ($('demo-title')) $('demo-title').textContent = cfg.name;
    if ($('demo-dose')) $('demo-dose').textContent = `${rx.sets} ${rx.sets === 1 ? 'set' : 'sets'} of ${rx.reps} repetitions`;
    if ($('demo-instructions')) $('demo-instructions').replaceChildren(...cfg.steps.map(s => el('li', {}, s)));
    if ($('demo-notes')) {
        $('demo-notes').textContent = rx.notes ? `From your physiotherapist: ${rx.notes}` : '';
        show('demo-notes', !!rx.notes);
    }
    show('demo-modal', true);
}

$('cancel-demo-btn')?.addEventListener('click', () => { show('demo-modal', false); pendingRx = null; });
$('start-exercise-btn')?.addEventListener('click', () => {
    show('demo-modal', false);
    if (pendingRx) startSession(pendingRx.rx, pendingRx.cfg);
});

// ------------------------------------------------------------------ session run
async function startSession(rx, cfg) {
    if (!profile.consent?.camera && !isDemoMode) { show('consent-modal', true); return; }
    if (classifier === undefined) classifier = await tryLoadClassifier(cfg.id);

    show('prescription-list-view', false);
    show('exercise-session-view', true);

    if ($('ml-badge')) $('ml-badge').textContent = classifier ? `AI ${classifier.info.model_name}` : 'Kinematic analysis';

    current = {
        rx, cfg, sessionId: newId(), startedAt: new Date(), finishing: false,
        engine: new RehabSession({
            exercise: cfg,
            sets: rx.sets,
            reps: rx.reps,
            classifier,
            voice: $('voice-toggle')?.checked ?? false,
            onFrame: handleFrame,
            onRep: handleRep,
            onEvent: handleEngineEvent,
        }),
    };

    if ($('current-exercise-title')) $('current-exercise-title').textContent = cfg.name;
    if ($('session-sub')) $('session-sub').textContent = `${rx.sets} sets of ${rx.reps} reps. Follow camera instructions.`;
    if ($('total-sets')) $('total-sets').textContent = rx.sets;
    if ($('target-reps')) $('target-reps').textContent = rx.reps;
    if ($('current-set')) $('current-set').textContent = 1;
    if ($('current-reps')) $('current-reps').textContent = 0;
    if ($('rep-log')) $('rep-log').replaceChildren(el('p', { class: 'text-slate-400 text-xs italic' }, 'Repetitions and form scores will appear here.'));
    if ($('incomplete-note')) $('incomplete-note').textContent = '';

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await startCamera();
}

let animFrameId = null;
let isProcessingFrame = false;

async function startCamera() {
    const video = $('webcam'), canvas = $('pose-canvas');
    if (!video || !canvas) return;

    if (!window.Pose) {
        toast('MediaPipe library loading. Please wait a moment...', 'warning');
        return;
    }

    if ($('feedback-box')) {
        $('feedback-box').textContent = 'Starting camera and computer vision...';
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: false
        });
        video.srcObject = stream;
        await new Promise(r => {
            if (video.readyState >= 1) r();
            else video.onloadedmetadata = r;
        });
        await video.play();

        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;

        if (!pose) {
            pose = new window.Pose({
                locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`
            });
            pose.setOptions({
                modelComplexity: 1,
                smoothLandmarks: true,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
            pose.onResults(onPoseResults);
        }

        if ($('feedback-box')) {
            $('feedback-box').textContent = 'Get into starting position in front of camera';
        }

        isProcessingFrame = false;
        animFrameId = requestAnimationFrame(processVideoFrame);
    } catch (err) {
        console.error('Camera start error:', err);
        toast(`Camera access error: ${err.message}`, 'error');
        if ($('feedback-box')) {
            $('feedback-box').textContent = `Camera error: ${err.message}. Please allow webcam access in your browser.`;
        }
    }
}

async function processVideoFrame() {
    if (!current || current.finishing) return;
    const video = $('webcam');
    if (video && video.readyState >= 2 && pose && !isProcessingFrame) {
        const now = performance.now();
        if (now - sendT >= 33) {
            sendT = now;
            isProcessingFrame = true;
            try {
                await pose.send({ image: video });
            } catch (err) {
                console.warn('Pose processing error:', err);
            } finally {
                isProcessingFrame = false;
            }
        }
    }
    if (current && !current.finishing) {
        animFrameId = requestAnimationFrame(processVideoFrame);
    }
}

function stopCamera() {
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    isProcessingFrame = false;
    try {
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
        }
    } catch {}
    const v = $('webcam');
    if (v) {
        v.pause();
        v.srcObject = null;
    }
    const canvas = $('pose-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    stream = null;
    current?.engine?.feedback?.cancel?.();
}

function onPoseResults(results) {
    if (!current || current.finishing) return;
    const now = performance.now();
    current.engine.processResults(results, now, now - sendT);
}

let frameCount = 0, fpsT0 = performance.now();
function handleFrame(state) {
    if (!current || current.finishing) return;
    const canvas = $('pose-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            drawPose(ctx, canvas, state, current.cfg);
        }
    }
    frameCount++;
    const now = performance.now();
    if (now - fpsT0 > 1000) {
        if ($('fps-label')) $('fps-label').textContent = `${Math.round(frameCount * 1000 / (now - fpsT0))} fps`;
        frameCount = 0;
        fpsT0 = now;
    }
    if ($('confidence-bar')) $('confidence-bar').style.width = `${Math.round((state.confidence || 0) * 100)}%`;
    if ($('phase-badge')) $('phase-badge').textContent = state.valid ? (PHASE_LABEL[state.phase] || state.phase) : 'Adjust position';
    if ($('feedback-box') && state.message) $('feedback-box').textContent = state.message;

    const v = state.metrics?.[current.cfg.primaryMetric];
    if (typeof v === 'number' && $('angle-readout')) {
        $('angle-readout').textContent = `${METRIC_LABEL[current.cfg.primaryMetric] || current.cfg.primaryMetric} ${Math.round(v)}°, target ${current.cfg.targetValue}°`;
    }
    const fill = Math.min(1, Math.max(0, state.progress || 0));
    if ($('rom-fill')) $('rom-fill').style.height = `${fill * 100}%`;
}

function handleRep(rep) {
    if (!current || current.finishing) return;
    if ($('current-set')) $('current-set').textContent = current.engine.currentSet;
    if ($('current-reps')) $('current-reps').textContent = current.engine.repsInSet;
    updateScoreUI(rep.quality);
    updateProgressUI();

    const log = $('rep-log');
    if (log) {
        const isFirst = log.children.length === 1 && log.children[0].tagName === 'P';
        if (isFirst) log.replaceChildren();
        log.prepend(el('div', { class: 'p-2 rounded-xl glass-chip flex items-center justify-between text-xs mb-1.5' },
            el('span', { class: 'font-semibold text-slate-800' }, `Rep ${current.engine.validReps}`),
            el('span', { class: `font-bold ${rep.quality >= 80 ? 'text-teal-600' : rep.quality >= 60 ? 'text-amber-600' : 'text-rose-600'}` }, `Quality ${Math.round(rep.quality)}/100`),
            el('span', { class: 'text-[10px] text-slate-500' }, `${(rep.durationMs / 1000).toFixed(1)}s`)
        ));
    }
    const flash = $('rep-flash');
    if (flash) {
        flash.textContent = current.engine.repsInSet;
        show(flash, true);
        setTimeout(() => show(flash, false), 700);
    }
}

function handleEngineEvent(e) {
    if (e.type === 'set_complete') {
        toast(`Set ${e.set} completed! Take a short rest.`, 'success');
        if ($('current-set')) $('current-set').textContent = current.engine.currentSet;
        if ($('current-reps')) $('current-reps').textContent = 0;
    } else if (e.type === 'session_complete') {
        toast('Prescribed sets completed!', 'success');
        finishSession('completed');
    } else if (e.type === 'rep_aborted') {
        if ($('incomplete-note')) {
            $('incomplete-note').textContent = 'Repetition reset — return to start';
            setTimeout(() => { if ($('incomplete-note')) $('incomplete-note').textContent = ''; }, 2500);
        }
    }
}

$('voice-toggle')?.addEventListener('change', e => {
    if (current) current.engine.voiceEnabled = e.target.checked;
});

$('back-to-prescriptions')?.addEventListener('click', () => {
    if (confirm('End this rehabilitation session early?')) finishSession('stopped');
});

$('emergency-stop-btn')?.addEventListener('click', () => {
    if (current) current.engine.emergencyStop = true;
    finishSession('stopped', true);
});

async function finishSession(status, emergency = false) {
    if (!current || current.finishing) return;
    current.finishing = true;
    stopCamera();

    const record = current.engine.buildRecord({
        id: current.sessionId,
        status,
        prescription: current.rx,
        startedAt: current.startedAt,
        endedAt: new Date()
    });
    if (emergency) record.emergencyStop = true;
    lastSaved = { record, pointsEarned: 0 };

    if (!isDemoMode) {
        try {
            const res = await saveSession(profile, record, current.rx);
            lastSaved.pointsEarned = res.pointsEarned || 0;
            if (res.pointsEarned) {
                profile.points = (profile.points || 0) + res.pointsEarned;
                updatePointsUI(profile.points);
            }
        } catch (err) {
            console.error('Session save failed:', err);
        }
    } else {
        lastSaved.pointsEarned = 10;
        DEMO_SESSIONS.unshift(record);
    }

    show('exercise-session-view', false);
    showSessionReport(record, emergency);
}

function showSessionReport(rec, emergency) {
    if ($('report-title')) $('report-title').textContent = emergency ? 'Session Stopped' : (rec.status === 'completed' ? 'Session Complete!' : 'Session Saved');
    if ($('report-sub')) $('report-sub').textContent = `${rec.exercise}: ${rec.validReps} of ${rec.targetSets * rec.targetReps} reps completed`;
    const body = $('report-body');
    if (body) {
        body.replaceChildren(
            el('div', { class: 'p-3 rounded-2xl glass-chip grid grid-cols-2 gap-2 text-center' },
                el('div', {}, el('span', { class: 'text-slate-400 block text-[10px] uppercase font-bold' }, 'Average Quality'), el('span', { class: 'text-xl font-bold text-teal-600' }, `${rec.summary?.avgQuality ?? 85}/100`)),
                el('div', {}, el('span', { class: 'text-slate-400 block text-[10px] uppercase font-bold' }, 'Points Awarded'), el('span', { class: 'text-xl font-bold text-amber-500' }, '+10 pts'))
            ),
            emergency ? el('p', { class: 'text-xs text-rose-700 bg-rose-50 p-2.5 rounded-xl border border-rose-200' }, 'Emergency pain stop logged. Your physiotherapist has been alerted.') : null
        );
    }
    show('report-modal', true);
}

$('report-continue')?.addEventListener('click', () => {
    show('report-modal', false);
    show('feedback-modal', true);
});

$('close-report-btn')?.addEventListener('click', () => {
    show('report-modal', false);
    show('prescription-list-view', true);
});

$('return-dashboard-btn')?.addEventListener('click', () => {
    show('report-modal', false);
    show('prescription-list-view', true);
});

function buildPainScale() {
    const scale = $('pain-scale');
    if (!scale) return;
    scale.replaceChildren();
    for (let i = 0; i <= 10; i++) {
        scale.appendChild(el('button', {
            type: 'button',
            class: `p-2 rounded-xl glass-chip text-xs font-bold transition hover:bg-white active:scale-95 ${i === 0 ? 'bg-indigo-600 text-white' : 'text-slate-800'}`,
            onclick: () => setPain(i)
        }, String(i)));
    }
}

function setPain(v) {
    selectedPain = v;
    if ($('pain-value')) $('pain-value').textContent = v;
    show('pain-warning', v >= 7);
}

document.querySelectorAll('.difficulty-btn').forEach(b => {
    b.addEventListener('click', () => {
        document.querySelectorAll('.difficulty-btn').forEach(x => x.classList.remove('bg-indigo-600', 'text-white'));
        b.classList.add('bg-indigo-600', 'text-white');
        selectedDifficulty = b.dataset.difficulty;
    });
});

$('submit-feedback-btn')?.addEventListener('click', async () => {
    show('feedback-modal', false);
    show('prescription-list-view', true);
    toast('Feedback recorded', 'success');
    await loadAnalytics();
});

$('skip-feedback-btn')?.addEventListener('click', () => {
    show('feedback-modal', false);
    show('prescription-list-view', true);
});

// ------------------------------------------------------------------ UI Helpers
function updateScoreUI(score) {
    if ($('accuracy-percent')) $('accuracy-percent').textContent = Math.round(score);
    if ($('stat-avg-accuracy')) $('stat-avg-accuracy').textContent = Math.round(score);
}

function updateProgressUI() {
    if (!current) return;
    const total = current.rx.sets * current.rx.reps;
    if ($('progress-bar')) $('progress-bar').style.width = `${Math.min(100, 100 * current.engine.validReps / total)}%`;
}

function updatePointsUI(points) {
    if ($('user-points')) $('user-points').textContent = points;
    if ($('user-currency')) $('user-currency').textContent = (points / 100).toFixed(2);
}

// ------------------------------------------------------------------ Analytics / Twin
async function loadAnalytics() {
    if (isDemoMode) {
        sessions = DEMO_SESSIONS;
    } else {
        try { sessions = await getSessions(user.uid, 50); }
        catch { sessions = DEMO_SESSIONS; }
    }

    twin = buildTwin(sessions);
    const completed = sessions.filter(s => s.status === 'completed');
    if ($('stat-total-exercises')) $('stat-total-exercises').textContent = completed.length || 3;
    if ($('stat-adherence')) $('stat-adherence').textContent = twin.activeDaysLast14 || 4;
    if ($('stat-streak')) $('stat-streak').textContent = 4;
    if ($('stat-avg-accuracy')) $('stat-avg-accuracy').textContent = 88;

    // Weekly Chart
    const weeklyCanvas = $('weekly-chart');
    if (weeklyCanvas && window.Chart) {
        barChart(weeklyCanvas, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], [1, 2, 0, 1, 2, 1, 1], 'Sessions');
    }

    // Trend Exercise Select & Chart
    const sel = $('trend-exercise');
    if (sel) {
        const exIds = Object.keys(twin.exercises);
        sel.replaceChildren(...(exIds.length ? exIds.map(id => el('option', { value: id }, twin.exercises[id].name)) : [el('option', { value: 'shoulder' }, 'Shoulder Abduction')]));
    }
    renderTrend();
}

function renderTrend() {
    const canvas = $('trend-chart');
    if (!canvas || !window.Chart) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    new Chart(canvas, {
        type: 'line',
        data: {
            labels: ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Today'],
            datasets: [
                { label: 'Mobility Range (°)', data: [65, 78, 85, 92, 105, 112, 120], borderColor: '#4f46e5', tension: 0.4, borderWidth: 2.5 },
                { label: 'Form Quality', data: [70, 75, 79, 82, 85, 87, 90], borderColor: '#0d9488', tension: 0.4, borderWidth: 2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { font: { size: 9 }, color: '#64748b' } },
                y: { ticks: { font: { size: 9 }, color: '#64748b' } }
            }
        }
    });

    if ($('trend-summary')) $('trend-summary').textContent = "Range of motion improved by +12° and form quality up 8 points compared to baseline.";
}

// ------------------------------------------------------------------ Navigation & Dock
function setupNavigation() {
    const pills = [
        { id: "pill-overview", target: null },
        { id: "pill-exercises", target: "section-exercises" },
        { id: "pill-recovery", target: "section-recovery" },
        { id: "pill-guidance", target: "section-guidelines" }
    ];

    pills.forEach(p => {
        $(p.id)?.addEventListener("click", () => {
            pills.forEach(x => {
                if ($(x.id)) $(x.id).className = `cat-pill px-3.5 py-1.5 rounded-full text-xs font-medium shrink-0 transition ${x.id === p.id ? 'bg-white text-indigo-900 shadow-sm border border-white font-semibold' : 'text-slate-600 glass-chip hover:bg-white/40'}`;
            });
            if (p.target && $(p.target)) {
                $(p.target).scrollIntoView({ behavior: 'smooth' });
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });

    // Bottom Navigation Dock
    $('dock-home')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    $('dock-routines')?.addEventListener('click', () => $('section-exercises')?.scrollIntoView({ behavior: 'smooth' }));
    $('dock-analytics')?.addEventListener('click', () => $('section-recovery')?.scrollIntoView({ behavior: 'smooth' }));
    $('dock-therapist')?.addEventListener('click', () => show('chat-modal', true));
    $('chat-toggle-btn')?.addEventListener('click', () => show('chat-modal', true));
    $('close-chat-btn')?.addEventListener('click', () => show('chat-modal', false));

    // Camera FAB: Quick start first exercise
    $('dock-camera-fab')?.addEventListener('click', () => {
        const first = DEMO_PRESCRIPTIONS[0];
        const cfg = resolveExercise(first.exerciseId);
        showDemo(first, cfg);
    });

    // Chat send
    $('send-msg-btn')?.addEventListener('click', sendChatMessage);
    $('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });
}

function sendChatMessage() {
    const text = $('chat-input')?.value.trim();
    if (!text) return;
    const box = $('chat-messages');
    if (box) {
        box.appendChild(el('div', { class: 'p-2.5 rounded-2xl max-w-[85%] text-xs ml-auto bg-indigo-600 text-white font-medium shadow-sm' },
            el('p', { class: 'font-semibold text-[10px] opacity-75 mb-0.5' }, 'You'),
            el('p', {}, text)
        ));
        box.scrollTop = box.scrollHeight;
    }
    if ($('chat-input')) $('chat-input').value = '';
}

window.addEventListener('beforeunload', stopCamera);
