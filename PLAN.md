# Encrypted DuckDB-Wasm Virtual File System — Implementation Plan

> **This file is LOCKED.** The implementer agent must NOT modify this file.
> The reviewer agent uses this as the source of truth for PASS/FAIL decisions.

## Architecture

A static website is packed into an AES-encrypted DuckDB database at build time.
At runtime, a minimal loader page (the only plaintext asset) boots DuckDB-Wasm,
prompts for the encryption key, attaches the encrypted DB via HTTP range requests,
and serves all pages/assets from the VFS.

```
[Build Time]                        [Runtime]
src/  ──► pack.mjs ──► dist/        Browser ──► index.html (loader)
  HTML        │         index.html            ──► site.duckdb (encrypted, range-fetched)
  CSS         │         site.duckdb           ──► DuckDB-Wasm decrypts blocks on demand
  JS          │
  images      │
              └─ DuckDB encrypted
```

Deployment directory (`dist/`) contains **exactly two files**: `index.html` and `site.duckdb`.

---

## Step 1: Project Scaffolding

- [ ] `npm init` with `"type": "module"`
- [ ] Install deps: `duckdb` (Node native for build), `@duckdb/duckdb-wasm` (client, loaded from CDN)
- [ ] Create directory structure:
  ```
  build/          # build script
  src/            # sample site content (already provided)
  dist/           # output (gitignored)
  client/         # loader source
  ```
- [ ] Add `.gitignore` for `node_modules/`, `dist/`
- [ ] Commit: "scaffold: project structure and dependencies"

## Step 2: Build Script (`build/pack.mjs`)

- [ ] Accept args: `--src <dir>` (default `src/`), `--out <dir>` (default `dist/`), `--key <encryption_key>`
- [ ] Walk `--src` recursively, collecting all files
- [ ] Determine MIME type for each file (use `mime-types` npm package or a simple lookup map)
- [ ] Create a DuckDB database with encryption enabled:
  ```sql
  PRAGMA enable_encryption;
  PRAGMA encryption_key = '<key>';
  -- or use ATTACH with ENCRYPTION_CONFIG depending on DuckDB version
  ```
- [ ] Create the VFS table:
  ```sql
  CREATE TABLE vfs (
    path    VARCHAR PRIMARY KEY,  -- e.g. '/index.html', '/images/logo.png'
    mime    VARCHAR NOT NULL,     -- e.g. 'text/html', 'image/png'
    content BLOB NOT NULL,
    size    BIGINT NOT NULL
  );
  ```
- [ ] Insert every file as a row (paths normalized to `/`-prefixed, forward slashes)
- [ ] Write encrypted DB to `<out>/site.duckdb`
- [ ] Copy the loader `index.html` to `<out>/index.html`
- [ ] Print summary: file count, total size, output path
- [ ] Commit: "build: pack.mjs encrypts site into DuckDB"

## Step 3: Client Loader (`client/index.html`)

This is a single, self-contained HTML file. **No external CSS/JS files** — everything is inlined.

- [ ] Inline styles for a minimal, clean key-prompt UI
- [ ] Load `@duckdb/duckdb-wasm` from CDN (jsdelivr or unpkg)
- [ ] On page load, show a password input + "Unlock" button
- [ ] On unlock:
  1. Initialize DuckDB-Wasm with the Web Worker + WASM bundle
  2. Register an HTTP file system pointing at `site.duckdb` (same origin, relative path)
  3. Attach the encrypted database with the user-provided key
  4. Query for `/index.html` and render it
- [ ] Show clear error message if key is wrong or DB can't be opened
- [ ] Commit: "client: loader page with DuckDB-Wasm init and key prompt"

## Step 4: Client-Side Router

- [ ] Use hash-based routing (`#/path`) for GitHub Pages compatibility
- [ ] `window.onhashchange` listener
- [ ] Default route: `#/` → query VFS for `/index.html`
- [ ] Route `#/about` → query VFS for `/about.html`
- [ ] Route `#/style.css` → inject as `<style>` in `<head>`
- [ ] Generic: determine action by MIME type from the VFS row
- [ ] Intercept clicks on `<a href="...">` inside rendered content:
  - Internal links → update hash, trigger router
  - External links → open normally
- [ ] Commit: "client: hash-based router with MIME-aware rendering"

## Step 5: Content Renderer

For each content type, implement a specific rendering strategy:

- [ ] **HTML**: Parse the HTML string. Before injecting into the DOM container, rewrite all asset references (see Step 6). Then set `container.innerHTML`.
- [ ] **CSS**: Create a `<style>` element, set its `textContent`, append to `<head>`. Track injected styles to avoid duplicates.
- [ ] **JavaScript**: Execute using `new Function()` or a `<script>` tag injection. Provide a sandboxed context if needed.
- [ ] **Images** (PNG/JPG/SVG/GIF): Query the BLOB from DuckDB, create a `Blob` object with the correct MIME type, generate a URL via `URL.createObjectURL()`, set as `src` on the `<img>` element.
- [ ] **PDF**: Same blob→objectURL approach, render in an `<iframe>` or `<embed>`.
- [ ] Commit: "client: MIME-aware content renderer"

## Step 6: Asset Interception

- [ ] After injecting HTML into the DOM, scan for elements with asset references:
  - `<img src="...">`
  - `<link rel="stylesheet" href="...">`
  - `<script src="...">`
  - `<a href="...">` (for internal navigation)
  - CSS `url(...)` references inside inline styles
- [ ] For each asset reference:
  1. Normalize the path (resolve relative paths against current route)
  2. Query the VFS: `SELECT content, mime FROM vfs WHERE path = ?`
  3. For binary assets: blob → objectURL → replace the attribute
  4. For CSS: inject as `<style>`
  5. For JS: execute via script injection
- [ ] Use a `MutationObserver` on the content container to catch dynamically inserted elements
- [ ] Cache objectURLs to avoid redundant queries; revoke old ones on navigation
- [ ] Commit: "client: asset interception and VFS resolution"

## Step 7: Integration & Polish

- [ ] Wire build script to copy `client/index.html` → `dist/index.html`
- [ ] Add an npm script: `"build": "node build/pack.mjs --key <key>"`
- [ ] Verify `dist/` contains exactly `index.html` + `site.duckdb`
- [ ] Add loading spinner/progress indicator during DuckDB init
- [ ] Handle 404: if a path is not in VFS, show a "Page not found" message
- [ ] Commit: "integration: build pipeline and polish"

## Step 8: Verification

- [ ] Run the build script and confirm it produces an encrypted DB
- [ ] Attempt to read `site.duckdb` without a key — must fail
- [ ] Serve `dist/` with a local HTTP server (e.g., `npx serve dist`)
- [ ] Open in browser, enter key, verify:
  - Home page renders with styles
  - Images load from VFS (not 404s from server)
  - Navigation between pages works
  - No network requests for individual assets (only range requests to .duckdb)
- [ ] Commit: "verified: all acceptance criteria pass"

---

## Acceptance Criteria (Reviewer Checklist)

1. ✅ Build script packs sample site into encrypted DuckDB
2. ✅ `dist/` contains only `index.html` and `site.duckdb` — no plaintext assets
3. ✅ Loader prompts for key and initializes DuckDB-Wasm
4. ✅ HTML pages render correctly with styles applied
5. ✅ Images load from VFS blobs via `objectURL` (not from server paths)
6. ✅ Client-side navigation between pages works
7. ✅ Wrong key shows an error, doesn't silently fail
8. ✅ DuckDB-Wasm uses range requests (httpfs) — no full DB download

## Known Technical Risks

- **DuckDB-Wasm encryption support**: The WASM build may not support the same encryption pragmas as the native build. If this is the case, the implementer should fall back to a manual encryption layer (e.g., encrypt the DB file with Web Crypto API and decrypt the full file in memory before loading).
- **httpfs + encryption**: Range requests on an encrypted DB only work if encryption is block-level. If DuckDB-Wasm doesn't support this natively, the fallback is full-file fetch + in-memory decrypt.
- **WASM memory**: Very large sites may exceed WASM memory limits. Not a concern for the sample site.

If a technical risk materializes and makes part of the plan infeasible, the reviewer should note this and issue a PASS with caveats rather than a FAIL, provided the implementer has documented the limitation and implemented a reasonable fallback.
