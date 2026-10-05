/* Booking Pass service worker — lets the app open with no signal.
   App files load instantly from the cache and refresh in the background, so a
   change shows up on the launch after next. Bump VERSION to force a clean reinstall. */
const VERSION = 'booking-pass-v2';

const APP_SHELL = [
  './',
  './index.html',
  './parse.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Must match the stylesheet links in index.html exactly.
const FONT_CSS = [
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Sharp:opsz,wght,FILL,GRAD@24,400,1,0&icon_names=add,call,check,chevron_left,close,cloud_done,cloud_off,confirmation_number,content_copy,content_paste,delete,directions_car,edit,expand_more,flight,fullscreen,hotel,ios_share,kayaking,local_activity,luggage,navigation,restaurant,sticky_note_2&display=block',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(APP_SHELL);
    // Fonts are best-effort: without them the app still works, in fallback fonts.
    await Promise.all(FONT_CSS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return;
        const css = await res.clone().text();
        await cache.put(url, res);
        // Only the Latin character sets; other scripts are fetched on demand if ever needed.
        const otherScripts = new Set([...css.matchAll(/\/\*\s*(?!latin)[\w-]+\s*\*\/\s*@font-face\s*\{[^}]*?url\(([^)]+)\)/g)].map((m) => m[1]));
        const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]).filter((f) => !otherScripts.has(f));
        await Promise.all(files.map(async (file) => {
          const font = await fetch(file, { mode: 'cors' });
          if (font.ok) await cache.put(file, font);
        }));
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(VERSION);
  const navigate = req.mode === 'navigate';
  const key = navigate ? './index.html' : req;
  const hit = await cache.match(key, { ignoreSearch: navigate });
  const update = fetch(req)
    .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}
