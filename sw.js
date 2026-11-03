// MediTask service worker.
// Network-first for app code (so updates reach patients immediately),
// cache fallback for offline use. Firebase / CDN traffic is never cached here.
const CACHE_NAME = 'meditask-v4';
const APP_SHELL = [
    './', './index.html', './login.html', './signup.html', './patient-dashboard.html', './doctor-dashboard.html',
    './css/app.css', './manifest.json', './404.html',
    './css/tw-index.css', './css/tw-login.css', './css/tw-signup.css', './css/tw-404.css',
    './css/tw-patient-dashboard.css', './css/tw-doctor-dashboard.css',
    './js/config.js', './js/patient-app.js', './js/doctor-app.js',
    './js/services/auth.js', './js/services/db.js',
    './js/rehabilitation/skeleton.js', './js/rehabilitation/angle-calculator.js', './js/rehabilitation/movement-filter.js',
    './js/rehabilitation/landmark-validator.js', './js/rehabilitation/exercise-configs.js', './js/rehabilitation/repetition-counter.js',
    './js/rehabilitation/movement-evaluator.js', './js/rehabilitation/feedback-engine.js', './js/rehabilitation/pose-engine.js',
    './js/intelligence/feature-extractor.js', './js/intelligence/dtw-analyzer.js', './js/intelligence/movement-classifier.js',
    './js/intelligence/rehabilitation-analytics.js', './js/digital-twin/progress-model.js',
    './js/ui/dom.js', './js/ui/icons.js', './js/ui/charts.js', './js/ui/exercise-visualizer.js', './js/ui/report-generator.js',
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).catch(err => console.log('Cache failed:', err)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))));
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
    event.respondWith(
        fetch(event.request)
            .then(res => {
                if (res && res.status === 200) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(event.request).then(hit => hit ||
                (event.request.headers.get('accept')?.includes('text/html') ? caches.match('./index.html') : undefined)))
    );
});
