'use strict';

const CACHE_NAME = 'hey-chill-v4';

const SHELL_ASSETS = [
    '/',
    '/static/main.js',
    '/static/style.css',
    '/manifest.json',
    '/static/icons/icon.svg',
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
    '/static/ort.min.js',
    '/static/openwakeword-engine.js',
];

// Wake word model assets — cached on first use (lazy), not at install time,
// because they are large (~17MB total including the WASM binary).
// The cache-first fetch handler below will cache them after first load.

/* ===== Install — pre-cache shell ===== */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

/* ===== Activate — remove stale caches ===== */
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

/* ===== Fetch — network-first for HTML, cache-first for assets ===== */
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only handle GET requests
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Skip non-same-origin, WebSocket upgrade, and API requests
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    const isHTMLRequest = request.headers.get('accept')?.includes('text/html');

    if (isHTMLRequest) {
        // Network-first for the app shell HTML
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match('/'))
        );
        return;
    }

    // Cache-first for static assets
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            });
        })
    );
});
