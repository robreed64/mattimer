// public/sw.js — BJJ Mat Timer Service Worker
// Provides offline caching and last-known-state preservation.
const CACHE_NAME  = 'bjj-timer-v38';
const STATE_KEY   = 'bjj-last-state';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/main.css',
  '/js/app.js',
  '/js/spotify.js',
  '/spotify-config.js',
  '/supabase.js',
  '/supabase-config.js',
  '/partysocket.js',
  '/partykit-config.js',
];

// ─── Install — cache app shell ────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate — clear old caches ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch — cache-first for assets, network-first for API/sockets ─
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept socket.io or API calls
  if (url.includes('/socket.io/') || url.includes('/api/') || url.includes('/audio/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // For app assets: network first, update cache, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ─── Message — store/retrieve last known timer state ──────────────
// The display page posts the latest state here so we can restore it
// if the page is reloaded while the server is offline.
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SAVE_STATE') {
    // Store in a dedicated cache entry
    caches.open(CACHE_NAME).then(c =>
      c.put(
        new Request(STATE_KEY),
        new Response(JSON.stringify(e.data.state), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
  }

  if (e.data.type === 'GET_STATE') {
    caches.open(CACHE_NAME).then(async c => {
      const res = await c.match(new Request(STATE_KEY));
      const state = res ? await res.json() : null;
      e.source.postMessage({ type: 'LAST_STATE', state });
    });
  }
});
