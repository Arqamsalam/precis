// Précis service worker: keeps the app available offline and enables multi-threaded voice/AI processing.
//
// Offline: app files are served from a local cache and refreshed in the background (stale-while-revalidate).
// Speed: browsers only allow multi-threaded WebAssembly on "cross-origin isolated" pages, which needs two
// response headers that GitHub Pages can't send. This worker adds them (COOP + COEP: credentialless).

const VERSION = 'precis-2026-10-27c';
const COEP = new URL(self.location.href).searchParams.get('coep'); // 'credentialless' when the browser supports it

const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/engine.js', 'js/export.js', 'js/extract.js', 'js/rewrite.js', 'js/sample.js', 'js/speech.js',
  'js/storage.js', 'js/summarizer.js', 'js/summarizer-worker.js', 'js/textutil.js', 'js/tts-worker.js', 'js/llm-worker.js',
  'js/pwa.js', 'vendor/marked.mjs', 'vendor/purify.mjs', 'vendor/jszip.mjs', 'vendor/mammoth.browser.min.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/docx.mjs', 'vendor/pdfmake.min.js', 'vendor/vfs_fonts.js',
  'assets/favicon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
];
// Fetched on first use and then kept: fonts and the text-recognition engine.
const RUNTIME = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net\/npm\/(tesseract\.js|tesseract\.js-core|@tesseract\.js-data))/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Add files one by one so a single failure doesn't block installation.
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('precis-') && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(sameOrigin(event, req));
  else if (RUNTIME.test(req.url)) event.respondWith(cacheFirst(req));
  // Anything else (AI model downloads) goes straight to the network; those libraries keep their own caches.
});

async function sameOrigin(event, req) {
  const cache = await caches.open(VERSION);
  if (req.mode === 'navigate') {
    // Fresh page when online, cached page when offline.
    try {
      const res = await fetch(req);
      if (res.ok) event.waitUntil(cache.put('index.html', res.clone()));
      return isolate(res);
    } catch {
      return isolate((await cache.match('index.html')) || (await cache.match('./')) || Response.error());
    }
  }
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res.ok && res.status === 200) event.waitUntil(cache.put(req, res.clone()));
    return res;
  });
  if (cached) {
    network.catch(() => {});
    return isolate(cached);
  }
  return isolate(await network);
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

function isolate(res) {
  if (!COEP || !res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
