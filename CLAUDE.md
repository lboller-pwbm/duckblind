# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An encrypted Virtual File System that packs a static website into a DuckDB database using native AES-GCM-256 block-level encryption. A minimal loader page connects to the encrypted database client-side using DuckDB-Wasm, then a service worker serves all content from the Cache API. Designed for GitHub Pages / S3 — no backend required.

## Build & Test Commands

```bash
# Build (requires DuckDB CLI v1.4.4+: brew install duckdb)
node build/pack.mjs --key <password>                    # packs src/ → dist/
node build/pack.mjs --src <dir> --out <dir> --key <key> # custom source/output

# Serve locally (use `serve` for range request support)
npx serve dist

# Build a Quarto book
node build/pack.mjs --src path/to/_book --key <key> --out dist-quarto
```

## Architecture

Four files deployed: `index.html` (loader), `sw.js` (service worker), `404.html` (deep-link redirect), `site.duckdb` (encrypted DB).

### Build pipeline (`build/pack.mjs`)
1. Walks source directory, inserts every file into a DuckDB `vfs` table (`path`, `mime`, `content` BLOB, `size`)
2. Uses DuckDB CLI v1.4.4+ via `execFileSync` (not the npm package — no prebuilt binary for Node 23/ARM64)
3. BLOBs inserted via `from_hex()` — NOT `'\x...'::BLOB` (that's a single-byte escape, not hex-to-blob)
4. Database is created with DuckDB's native block-level encryption via `ATTACH ... (ENCRYPTION_KEY '...')`
5. CLI uses OpenSSL for encrypted writes; DuckDB-Wasm uses MbedTLS for encrypted reads

### Client runtime (`client/index.html`)
Single self-contained file. After the user enters the encryption key:

1. Loads DuckDB-Wasm v1.32.0 from CDN (SRI-verified)
2. Registers the encrypted DB via `registerFileURL` (HTTP protocol)
3. ATTACHes with `ENCRYPTION_KEY` — DuckDB-Wasm decrypts blocks on-demand via range requests
4. Queries all VFS rows, populates Cache API with `Response` objects
5. Reloads — SW serves everything from cache (ES modules, `fetch()`, CSS `@import` all work natively)
6. `/__lock` route clears cache and returns to key prompt

### Service worker (`client/sw.js`)
Cache-first: tries exact match first, then falls back to `{ ignoreSearch: true }` (handles query-string cache busters like `bootstrap-icons.woff?v=abc`). Navigation fallbacks: tries `path.html` then `path/index.html`. Skips cross-origin requests and `/sw.js`, `/site.duckdb`.

## Key Constraints

- `ROADMAP.md` contains the Phase 3b lazy on-demand serving plan and remaining test items
- DuckDB CLI v1.4.4+ required for native encryption (OpenSSL). DuckDB-Wasm v1.32.0 reads via MbedTLS.
- Service workers require HTTPS (or localhost). S3 alone won't work — needs CloudFront or GitHub Pages.
- CDN scripts are SRI-verified: worker scripts and WASM binaries are fetched, hashed, and loaded from verified blob URLs. The ESM module is hash-checked then imported from the CDN URL (best-effort — browser may re-fetch, but the version pin limits exposure). If you bump the DuckDB-Wasm version, regenerate all hashes:
  ```bash
  # ESM, MVP worker, EH worker, MVP WASM, EH WASM
  for p in "+esm" "dist/duckdb-browser-mvp.worker.js" "dist/duckdb-browser-eh.worker.js" "dist/duckdb-mvp.wasm" "dist/duckdb-eh.wasm"; do
    curl -sL "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@VERSION/$p" | openssl dgst -sha384 -binary | openssl base64 -A; echo " $p"
  done
  ```
- Cache persists across sessions. Users must navigate to `/__lock` or clear browser data to re-lock.

## GitHub Action (`action.yml`)

Composite action for other repos to pack a folder and deploy to Pages:

```yaml
# Pin to a release tag (e.g., @v1) for production use
- uses: lboller-pwbm/duckblind@main
  with:
    source-dir: docs/_book
    encryption-key: ${{ secrets.VFS_ENCRYPTION_KEY }}
```

Installs DuckDB CLI v1.4.4 on the runner, checks out this repo for the build tooling, runs the build, uploads the Pages artifact. The example workflow at `.github/workflows/example-deploy.yml` shows the full two-job (build + deploy) pattern with path filtering.

## Known Gotchas

- SQL injection via filenames: `sqlEscape()` doubles single quotes but paths are still interpolated into SQL strings, not parameterized
- `dist/` is gitignored; `dist-quarto/` is not in `.gitignore` — add it if you use custom output dirs
- roborev post-commit hooks auto-review every commit; use `roborev show HEAD` to see findings
