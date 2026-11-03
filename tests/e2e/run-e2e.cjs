// Browser end-to-end test with Playwright (Chromium), fake Firebase and stub MediaPipe.
//   python3 -m http.server 8765 &   (from the repo root)
//   node tests/e2e/run-e2e.cjs
// External CDNs are replaced by local stubs, so it runs offline.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8765';
const OUT = process.env.E2E_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const stub = (f) => fs.readFileSync(path.join(__dirname, 'stubs', f), 'utf8');

async function page(browser, seed) {
    const ctx = await browser.newContext({ viewport: { width: +(process.env.E2E_W || 1400), height: +(process.env.E2E_H || 1200) }, permissions: ['camera'] });
    await ctx.route('**/*', async (route) => {
        const u = route.request().url();
        const js = (body) => route.fulfill({ status: 200, contentType: 'application/javascript', body });
        if (u.includes('firebase-app.js')) return js(stub('firebase-app.js'));
        if (u.includes('firebase-auth.js')) return js(stub('firebase-auth.js'));
        if (u.includes('firebase-firestore.js')) return js(stub('firebase-firestore.js'));
        if (u.includes('@mediapipe/pose')) return js(stub('mediapipe.js'));
        if (u.includes('@mediapipe/camera_utils')) return js('');
        // optional: E2E_ASSETS=<dir with node_modules/chart.js and @fontsource/ibm-plex-sans> for realistic screenshots
        const A = process.env.E2E_ASSETS;
        if (A && u.includes('chart.js')) return js(fs.readFileSync(path.join(A, 'node_modules/chart.js/dist/chart.umd.js'), 'utf8') + ';' + stub('globals.js').replace(/window\.Chart = [^\n]*\n/, ''));
        if (A && u.includes('fonts.googleapis')) {
            const dir = path.join(A, 'node_modules/@fontsource/ibm-plex-sans');
            const css = ['400', '500', '600'].map(w => fs.readFileSync(path.join(dir, `latin-${w}.css`), 'utf8')).join('\n').replace(/url\(\.\/files\//g, `url(${BASE}/__fonts/`);
            return route.fulfill({ status: 200, contentType: 'text/css', body: css });
        }
        if (A && u.includes('/__fonts/')) return route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(A, 'node_modules/@fontsource/ibm-plex-sans/files', u.split('/__fonts/')[1])) });
        if (u.includes('jspdf')) return js(stub('globals.js').replace(/window\.Chart = [^\n]*\n/, '').replace(/^/, 'if (!window.Chart) window.Chart = class { destroy() {} };\n'));
        if (u.includes('chart.js')) return js(stub('globals.js'));
        // optional: E2E_TW_CSS=<compiled tailwind.css> for realistic screenshots
        if (u.includes('cdn.tailwindcss.com')) return js(process.env.E2E_TW_CSS
            ? `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(fs.readFileSync(process.env.E2E_TW_CSS, 'utf8'))};document.head.appendChild(s);})();` : '');
        if (u.includes('fonts.googleapis') || u.includes('fonts.gstatic')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        if (u.includes('/models/web/') || u.includes('/models/templates/')) return route.fulfill({ status: 404, body: '' });
        if (u.startsWith(BASE)) return route.continue();
        return route.fulfill({ status: 404, body: '' });
    });
    await ctx.addInitScript((s) => {
        window.__FAKE = s;
        // fake camera stream
        navigator.mediaDevices.getUserMedia = async () => {
            const c = document.createElement('canvas'); c.width = 640; c.height = 360;
            const g = c.getContext('2d'); setInterval(() => { g.fillStyle = '#123'; g.fillRect(0, 0, 640, 360); }, 100);
            return c.captureStream(30);
        };
        document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.hidden{display:none!important} @media (min-width:768px){.md\\:flex{display:flex!important}}'; document.head.appendChild(st); });
        window.confirm = () => true;
        window.alert = () => {};
    }, seed);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    // 404s for models/web and models/templates are expected (no model installed -> rule-based mode)
    p.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
    return { p, errors, ctx };
}

const now = Date.now();
const day = 864e5;
function seedPatientWorld() {
    const docs = {
        'users/drA': { uid: 'drA', role: 'doctor', email: 'dra@example.com', displayName: 'Dr. Asha', doctorId: null },
        'users/pat1': { uid: 'pat1', role: 'patient', email: 'pat1@example.com', displayName: 'Meera', doctorId: 'drA', points: 20, consent: { camera: true } },
        'users/pat1/prescriptions/rx1': { doctorId: 'drA', patientId: 'pat1', exerciseId: 'squat', exercise: 'Squat', sets: 1, reps: 3, notes: 'Go slowly', status: 'active', assignedAt: new Date(now - day) },
        'users/pat1/messages/m1': { senderId: 'drA', senderRole: 'doctor', senderName: 'Dr. Asha', text: '<img src=x onerror="window.__xss=1">Hello', createdAt: new Date(now - 3600e3) },
    };
    for (let i = 0; i < 5; i++) {
        docs[`users/pat1/sessions/old${i}`] = {
            patientId: 'pat1', exerciseId: 'squat', exercise: 'Squat', status: 'completed', validReps: 10, incompleteReps: 0, targetSets: 1, targetReps: 10,
            startedAt: new Date(now - (6 - i) * day), reps: [],
            summary: { avgQuality: 70 + 3 * i, rom: { knee_l: { bestRange: 55 + 4 * i, meanRange: 50 }, knee_r: { bestRange: 54 + 4 * i, meanRange: 50 } }, symmetry: { 'knee_l|knee_r': 6 - i }, consistency: 85, errorCounts: { forward_lean: 2 } },
            feedback: { pain: 3, difficulty: 'medium', notes: '' },
        };
    }
    return docs;
}

(async () => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream'] });
    const results = [];
    const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`); };

    // ---------------------------------------------------------------- patient
    {
        const { p, errors } = await page(browser, { user: { uid: 'pat1', email: 'pat1@example.com' }, docs: seedPatientWorld() });
        await p.goto(`${BASE}/patient-dashboard.html`);
        await p.waitForSelector('#main-content:not(.hidden)', { timeout: 10000 });
        await p.waitForFunction(() => document.querySelectorAll('#prescription-list button').length > 0, null, { timeout: 10000 });
        check('patient: prescription card rendered', true);
        check('patient: no sample prescriptions', !(await p.textContent('#prescription-list')).includes('Right Hand Raise'));
        const streak = await p.textContent('#stat-total-exercises');
        check('patient: analytics from history', streak.trim() === '5', `sessions=${streak}`);
        await p.waitForTimeout(1200);
        await p.screenshot({ path: path.join(OUT, 'patient-home.png') });

        await p.click('#prescription-list button');
        await p.waitForSelector('#demo-modal:not(.hidden)');
        check('patient: demo shows physio note', (await p.textContent('#demo-notes')).includes('Go slowly'));
        await p.click('#start-exercise-btn');
        await p.waitForSelector('#exercise-session-view:not(.hidden)');
        await p.waitForTimeout(4500);
        await p.screenshot({ path: path.join(OUT, 'patient-session.png') });
        const phase = await p.textContent('#phase-badge');
        check('patient: live phase indicator', ['Rest', 'Moving', 'Hold', 'Return'].includes(phase.trim()) || phase.includes('Paused'), phase);

        await p.waitForSelector('#report-modal:not(.hidden)', { timeout: 25000 });
        const sub = await p.textContent('#report-sub');
        check('patient: session completes after 3 squats', sub.includes('3 of 3'), sub);
        await p.screenshot({ path: path.join(OUT, 'patient-report.png') });
        const pts = await p.textContent('#user-points');
        check('patient: +10 points awarded', pts.trim() === '30', pts);

        await p.click('#report-continue');
        await p.waitForSelector('#feedback-modal:not(.hidden)');
        await p.click('#pain-scale [data-pain="8"]');
        await p.click('[data-difficulty="hard"]');
        await p.click('#submit-feedback-btn');
        await p.waitForSelector('#feedback-modal.hidden', { state: 'attached' });
        await p.waitForTimeout(800);

        const store = await p.evaluate(() => window.__FAKE.docs);
        const sessKey = Object.keys(store).find(k => k.startsWith('users/pat1/sessions/') && !k.includes('old'));
        const sess = store[sessKey];
        check('store: session saved with standard record', !!sess && sess.validReps === 3 && sess.reps.length >= 3 && sess.summary && sess.status === 'completed',
            sess ? `valid=${sess.validReps} reps=${sess.reps.length} q=${sess.summary.avgQuality}` : 'missing');
        check('store: per-rep ROM recorded', !!sess?.reps?.[0]?.rom?.knee_l, JSON.stringify(sess?.reps?.[0]?.rom || {}));
        check('store: prescription completed', store['users/pat1/prescriptions/rx1'].status === 'completed' && store['users/pat1/prescriptions/rx1'].lastSessionId === sessKey.split('/').pop());
        check('store: feedback attached', sess?.feedback?.pain === 8 && sess.feedback.difficulty === 'hard');
        const alerts = Object.entries(store).filter(([k]) => k.startsWith('users/pat1/alerts/')).map(([, v]) => v.type);
        check('store: pain alert raised', alerts.includes('pain'), alerts.join(','));

        await p.click('#chat-toggle-btn');
        await p.waitForTimeout(400);
        const xss = await p.evaluate(() => window.__xss);
        check('chat: message HTML not executed', xss === undefined && (await p.textContent('#chat-messages')).includes('<img'));
        await p.fill('#chat-input', 'Knee felt sore today');
        await p.click('#send-msg-btn');
        await p.waitForTimeout(300);
        const store2 = await p.evaluate(() => window.__FAKE.docs);
        check('chat: message stored in patient thread', Object.entries(store2).some(([k, v]) => k.startsWith('users/pat1/messages/') && v.text === 'Knee felt sore today' && v.senderRole === 'patient'));
        check('patient page: no runtime errors', errors.length === 0, errors.join(' | '));
        fs.writeFileSync(path.join(OUT, 'patient-store.json'), JSON.stringify(store2, null, 1));
    }

    // ---------------------------------------------------------------- doctor
    {
        const docs = seedPatientWorld();
        docs['users/pat1/alerts/a1'] = { type: 'pain', message: 'Pain 8/10 reported after Squat', acknowledged: false, createdAt: new Date(now - 600e3) };
        docs['users/pat2'] = { uid: 'pat2', role: 'patient', email: 'other@example.com', doctorId: 'drB', points: 0 };
        const { p, errors } = await page(browser, { user: { uid: 'drA', email: 'dra@example.com' }, docs });
        await p.goto(`${BASE}/doctor-dashboard.html`);
        await p.waitForSelector('#main-content:not(.hidden)', { timeout: 10000 });
        await p.waitForFunction(() => document.querySelectorAll('#patient-list button').length > 0, null, { timeout: 10000 });
        const list = await p.textContent('#patient-list');
        check('doctor: only own patients listed', list.includes('Meera') && !list.includes('other@example.com'));
        check('doctor: alert badge', list.includes('1'));
        await p.click('#patient-list button');
        await p.waitForFunction(() => document.querySelectorAll('#twin-tiles > div').length === 4, null, { timeout: 10000 });
        const tiles = await p.textContent('#twin-tiles');
        check('doctor: digital twin tiles', tiles.includes('Range of motion') && tiles.includes('from baseline'), tiles.replace(/\s+/g, ' ').slice(0, 160));
        check('doctor: alerts shown', (await p.textContent('#alerts-box')).includes('Pain 8/10'));
        await p.waitForTimeout(1200);   // let charts draw
        await p.screenshot({ path: path.join(OUT, 'doctor-twin.png') });

        await p.click('[data-tab="sessions"]');
        await p.waitForTimeout(200);
        check('doctor: sessions listed', (await p.$$('#session-list > div')).length === 5);
        await p.click('[data-tab="prescriptions"]');
        await p.selectOption('#exercise-select', 'shoulder_abduction');
        await p.fill('#sets-input', '2'); await p.fill('#reps-input', '8');
        await p.click('#prescription-form button[type=submit]');
        await p.waitForTimeout(500);
        const store = await p.evaluate(() => window.__FAKE.docs);
        check('doctor: prescription written under patient', Object.entries(store).some(([k, v]) => k.startsWith('users/pat1/prescriptions/') && v.exerciseId === 'shoulder_abduction' && v.sets === 2 && v.doctorId === 'drA'));
        await p.screenshot({ path: path.join(OUT, 'doctor-prescriptions.png'), fullPage: true });

        await p.click('#export-pdf-btn');
        await p.waitForTimeout(200);
        check('doctor: PDF report generated', !!(await p.evaluate(() => window.__pdfSaved)));
        await p.click('#link-patient-btn');
        await p.fill('#link-patient-email', 'New.Patient@Example.com');
        await p.click('#submit-link-patient-btn');
        await p.waitForTimeout(400);
        const s2 = await p.evaluate(() => window.__FAKE.docs);
        check('doctor: invitation created (lower-cased email)', Object.entries(s2).some(([k, v]) => k.startsWith('link_requests/') && v.patientEmail === 'new.patient@example.com' && v.status === 'pending'));
        check('doctor page: no runtime errors', errors.length === 0, errors.join(' | '));
    }

    // ---------------------------------------------------------------- sign-in pages (visual + no errors)
    for (const pg of ['login', 'signup']) {
        const { p, errors } = await page(browser, { user: null, docs: {} });
        await p.goto(`${BASE}/${pg}.html`);
        await p.waitForTimeout(600);
        await p.screenshot({ path: path.join(OUT, `${pg}.png`) });
        check(`${pg} page: renders without errors`, errors.length === 0 && (await p.$$('form .input')).length >= 2, errors.join(' | '));
    }

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
