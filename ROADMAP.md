# Roadmap

## Remaining Testing

Items not yet validated after the v2 native encryption migration:

- [ ] **Range request verification**: Confirm DuckDB-Wasm sends `Range` headers on a server that supports them (GitHub Pages, S3+CloudFront, `npx serve`). Local Python `http.server` doesn't support ranges — use network tab to verify partial fetches.
- [ ] **Quarto book test**: Build a Quarto book with v2 (`node build/pack.mjs --src path/to/_book --key ...`), verify all chapters render, sidebar navigation, search, Bootstrap Icons font (woff with query-string cache buster).
- [ ] **Deep link test**: Verify 404.html redirect → loader → unlock → navigate to deep link works end-to-end on GitHub Pages.
- [ ] **GitHub Pages deployment**: Confirm the deploy workflow succeeds with DuckDB CLI v1.4.4 and the site works at the Pages URL.
- [ ] **Large site benchmark**: Compare total download size and time for a ~50MB site between v1 (whole-file) and v2 (native encryption). For Phase 3a (full table scan), total bytes should be similar but peak memory should be lower (~1x vs ~2x DB size).

## Phase 3b: Lazy On-Demand Serving

**Goal**: Only download the blocks containing pages the user actually visits. For a 50MB Quarto book, visiting 3 pages might download <2MB instead of 50MB.

### Current Flow (Phase 3a)

```
loader → enter key → ATTACH → query ALL vfs rows → populate Cache API → reload()
                                                                          ↓
                                          SW serves everything from cache (DuckDB closed)
```

Total data downloaded ≈ full DB (table scan reads all blocks). DuckDB connection is destroyed by the reload.

### Target Flow (Phase 3b)

```
loader → enter key → ATTACH → render VFS index.html in-place (no reload)
                                  ↓
                    DuckDB connection stays alive in module scope
                                  ↓
              SW fetch event → cache miss → postMessage to main thread
                                              ↓
                              main thread queries: SELECT content, mime FROM vfs WHERE path = ?
                                              ↓
                              DuckDB fetches only the blocks containing that row (range request)
                                              ↓
                              SW caches response, returns it to browser
```

Only the blocks containing requested pages are downloaded. DuckDB's block-level encryption + HTTP range requests make this efficient.

### Implementation Plan

#### 1. Keep DuckDB alive after unlock

**Current**: After populating the cache, the loader calls `conn.close()`, `db.terminate()`, then `location.reload()`.

**Change**: Don't reload. Instead:
- Determine the target: parse the validated `?redirect=` param as a URL if present, otherwise default to the app root
- Convert the target to a **scope-relative VFS path**: strip the app base prefix from the pathname (e.g. `/duckblind/about` → `/about`), then strip query string and hash (those are URL decorations, not VFS keys)
- Apply the same navigation fallbacks the SW uses: try `vfsPath`, then `vfsPath + '.html'`, then `vfsPath + '/index.html'` — **track which candidate matched**
- Query VFS for the matched scope-relative path's content
- Derive the **canonical browser URL** from the matched fallback, not the original request. If `/foo/index.html` matched, the browser-visible URL must be `/foo/` (with trailing slash) so that relative asset URLs in the HTML resolve within the correct directory. If `/foo.html` matched, use `/foo`.
- **Before writing the document**, call `history.replaceState()` with the canonical URL (base + canonical path + search + hash), or inject a `<base href="canonicalDir">` element into the HTML, so that relative resources resolve correctly on first parse
- Replace the document in-place: `document.open(); document.write(html); document.close();`
- Keep `db` and `conn` alive in module-scoped variables
- The replaced document inherits the SW registration

**Edge case**: The replaced document loses the module script context. Store the DuckDB connection in a global (`window.__duckdb = { db, conn }`) before replacing, or use a `MessageChannel` set up before the replacement.

#### 2. Add message handler for SW queries

In the loader (before document replacement), set up a message listener:

```javascript
navigator.serviceWorker.addEventListener('message', async (event) => {
  const { path, port } = event.data;
  try {
    const result = await conn.query(
      `SELECT content, mime FROM vfs WHERE path = '${path.replace(/'/g, "''")}'`
    );
    const row = result.toArray()[0];
    port.postMessage({ content: row.content, mime: row.mime });
  } catch (e) {
    port.postMessage({ error: e.message });
  }
});
```

This listener survives `document.open/write/close` because it's registered on `navigator.serviceWorker`, not the document.

#### 3. Modify SW fetch handler

On cache miss, instead of falling through to network:

```javascript
// In sw.js fetch handler, after cache miss:

// Convert browser-visible pathname to scope-relative VFS path.
// On subpath deployments (e.g. /duckblind/about), strip the SW scope prefix
// so VFS queries use paths like /about that match what the build inserted.
const scope = self.registration.scope; // e.g. "https://user.github.io/duckblind/"
const scopePath = new URL(scope).pathname;  // e.g. "/duckblind/"
let vfsPathname = url.pathname;
if (vfsPathname.startsWith(scopePath)) {
  vfsPathname = '/' + vfsPathname.slice(scopePath.length);
}

// Normalize the path the same way the SW handles navigation fallbacks.
// Each candidate maps to a canonical browser URL so relative assets resolve correctly:
//   /foo         → try /foo, /foo.html (canonical: /foo), /foo/index.html (canonical: /foo/)
//   /foo/        → try /foo/, /foo/index.html (canonical: /foo/)
const candidates = [{ vfs: vfsPathname, canonical: vfsPathname }];
if (!vfsPathname.endsWith('/') && !vfsPathname.includes('.')) {
  candidates.push(
    { vfs: vfsPathname + '.html', canonical: vfsPathname },
    { vfs: vfsPathname + '/index.html', canonical: vfsPathname + '/' }
  );
} else if (vfsPathname.endsWith('/')) {
  candidates.push({ vfs: vfsPathname + 'index.html', canonical: vfsPathname });
}

// Try each client sequentially — a MessagePort can only be transferred once,
// so we create a fresh channel per attempt. Treat per-client errors as a miss
// and continue probing (a stale tab may error while another tab has a live connection).
const clients = await self.clients.matchAll();
let response = null;
for (const { vfs: vfsPath, canonical } of candidates) {
  for (const client of clients) {
    const { port1, port2 } = new MessageChannel();
    client.postMessage({ path: vfsPath, port: port2 }, [port2]);
    const result = await Promise.race([
      new Promise(resolve => {
        port1.onmessage = (e) => resolve(e.data);
      }),
      new Promise(resolve => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!result || result.error) continue; // timeout or error — try next client
    response = new Response(result.content, {
      headers: { 'Content-Type': result.mime }
    });
    break;
  }
  if (response) break;
}
if (response) {
  // Cache under both the original request URL and the canonical URL.
  // This ensures /foo hits cache on revisit even though the content
  // was resolved via /foo/index.html (canonical: /foo/).
  cache.put(request, response.clone());
  const canonicalUrl = new URL(scopePath + canonical.slice(1), self.location.origin);
  if (canonicalUrl.href !== request.url) {
    cache.put(new Request(canonicalUrl), response.clone());
  }
  return response;
}
// No client responded — fall through to network or redirect to loader
```

#### 4. Handle connection lifecycle

**Tab closed**: DuckDB connection dies. When the user reopens:
- SW still has cached pages from before
- New cache misses have no DuckDB to query → fall through to network (404)
- Detect this: if no client responds within a timeout, redirect to the loader for re-authentication

**Multiple tabs**: Only one tab has the DuckDB connection. Use `clients.matchAll()` and try each until one responds.

**Explicit lock**: `/__lock` clears cache AND terminates DuckDB connection.

#### 5. Prefetch strategy (optional optimization)

After rendering the initial page, prefetch navigation targets in the background:
- Parse the rendered HTML for `<a href="...">` links
- Query DuckDB for those paths and populate the cache
- This makes common navigation patterns feel instant while still being lazy

### Files Changed

| File | Change |
|------|--------|
| `client/index.html` | Don't reload; replace document in-place; keep DuckDB alive; add message handler |
| `client/sw.js` | On cache miss, postMessage to main thread instead of network fallback |

### Risks

| Risk | Mitigation |
|------|------------|
| `document.open/write/close` loses event listeners | Register SW message listener on `navigator.serviceWorker` (survives document replacement) |
| Tab closure kills DuckDB — stale partial cache | SW timeout on postMessage; redirect to loader if no response |
| MessageChannel overhead per request | Only on cache miss; subsequent requests served from cache |
| Multiple tabs race condition | `clients.matchAll()` tries all; first response wins |
| Content Security Policy blocks `document.write` | Unlikely on self-hosted loader; test with GitHub Pages CSP |
