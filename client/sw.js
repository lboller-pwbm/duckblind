/**
 * Service Worker for transparent VFS serving.
 *
 * Cache-first strategy: once the main thread populates the cache with
 * decrypted VFS entries, this SW intercepts all same-origin fetches and
 * serves them from Cache API. ES modules, fetch(), CSS @import all work
 * natively because the browser sees normal HTTP responses.
 */

const CACHE_NAME = 'vfs-cache-v1';
// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // Activate immediately — don't wait for old SW to retire
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Claim all open clients so we start intercepting immediately
      await self.clients.claim();
      // Delete any old caches (from previous versions)
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })()
  );
});

// ─── Fetch Handler ────────────────────────────────────────────────────────────

async function handleRequest(request, url) {
  const cache = await caches.open(CACHE_NAME);

  // 1. Try exact match first (preserves query-sensitive semantics)
  let response = await cache.match(request);
  if (response) return response;

  // 1b. Fall back to ignoreSearch for cache-busted assets (e.g. ?v=abc)
  response = await cache.match(request, { ignoreSearch: true });
  if (response) return response;

  // 2. For navigation requests or extensionless paths, try HTML fallbacks
  const isNavigation = request.mode === 'navigate';
  const hasExtension = url.pathname.split('/').pop().includes('.');

  if (isNavigation || !hasExtension) {
    const pathname = url.pathname;

    // Try pathname + '.html' (e.g., /duckblind/about → /duckblind/about.html)
    if (!pathname.endsWith('/')) {
      response = await cache.match(new Request(url.origin + pathname + '.html'), { ignoreSearch: true });
      if (response) return response;
    }

    // Try pathname/index.html (e.g., /duckblind/ → /duckblind/index.html)
    const dir = pathname.endsWith('/') ? pathname : pathname + '/';
    response = await cache.match(new Request(url.origin + dir + 'index.html'), { ignoreSearch: true });
    if (response) return response;
  }

  // 3. Cache miss — fall through to network (serves real index.html pre-unlock)
  try {
    return await fetch(request);
  } catch (err) {
    // 4. Network also failed — return 404
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip cross-origin requests entirely
  if (url.origin !== self.location.origin) return;

  // Skip our own infrastructure files — use scope-relative paths so we don't
  // accidentally match VFS assets that happen to be named sw.js or site.duckdb
  const scope = self.registration.scope;
  const scopeUrl = new URL(scope);
  if (url.pathname === scopeUrl.pathname + 'sw.js' ||
      url.pathname === scopeUrl.pathname + 'site.duckdb') return;

  // All other same-origin requests: intercept
  event.respondWith(handleRequest(event.request, url));
});

// ─── Message Handler ──────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-cache') {
    event.waitUntil(
      (async () => {
        await caches.delete(CACHE_NAME);
        // Post back confirmation to the client that sent the message
        event.source.postMessage({ type: 'cache-cleared' });
      })()
    );
  }
});
