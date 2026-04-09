# duckblind

Host a fully private, media-rich website on a public static host (GitHub Pages, S3 + CloudFront). All site content is packed into a DuckDB database with native AES-GCM-256 block-level encryption at build time. A service worker decrypts and serves everything client-side — no backend required.

*A [duck blind](https://en.wikipedia.org/wiki/Hunting_blind) is a concealment structure — your site is hidden in plain sight.*

## How it works

```
Build time:  src/ files → DuckDB CLI → native encrypted site.duckdb
Runtime:     Browser → enter key → ATTACH with ENCRYPTION_KEY → populate Cache API → service worker serves everything
```

Four files are deployed: `index.html` (loader), `sw.js` (service worker), `404.html` (deep-link redirect), `site.duckdb` (encrypted database). The first three are bootstrap code — no site content exists as plaintext on the server.

After the user enters the encryption key, the loader connects to the encrypted database using DuckDB-Wasm's native encryption support. DuckDB fetches blocks on-demand via HTTP range requests and decrypts them using the key. The loader queries all VFS entries, populates the browser's Cache API, then reloads. The service worker intercepts all subsequent requests and serves them from cache — transparently. ES modules, `fetch()`, CSS `@import`, fonts, and images all work natively.

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org/) 18+ and [DuckDB CLI](https://duckdb.org/docs/installation/) v1.4.4+

```bash
# Build the sample site
VFS_KEY=testkey123 npm run build

# Serve locally
npx serve dist
# Open http://localhost:3000 and enter: testkey123
```

### Pack your own site

```bash
node build/pack.mjs --src path/to/your/site --key "your-secret-key"
```

This works with any static site output — plain HTML, Quarto books, Hugo, Jekyll, etc.

## GitHub Action

Use this repo as a GitHub Action to encrypt and deploy from any other repository:

```yaml
# .github/workflows/deploy-vfs.yml
name: Deploy Encrypted Site
on:
  push:
    branches: [main]
    paths: ['docs/_book/**']  # only when content changes
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
      # Pin to a release tag (e.g., @v1) for production use
      - uses: lboller-pwbm/duckblind@main
        with:
          source-dir: docs/_book
          encryption-key: ${{ secrets.VFS_ENCRYPTION_KEY }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v5
```

**Setup:** In your repo, go to Settings > Pages > Source: "GitHub Actions", then add a secret `VFS_ENCRYPTION_KEY` under Settings > Secrets.

## Locking

Navigate to `/__lock` to clear the decrypted cache and return to the key prompt. The cache persists across page reloads until explicitly locked.

## Security model

| Property | Status |
|----------|--------|
| Encryption at rest | DuckDB native AES-GCM-256 block-level encryption |
| Key transmission | Never leaves the browser |
| Plaintext on server | Bootstrap code only (`index.html`, `sw.js`, `404.html`) — no site content |
| CDN assets (DuckDB-Wasm) | Worker and WASM binaries SRI hash-verified; ESM module hash-checked then imported from CDN (best-effort — browser may re-fetch) |
| Offline brute force | Possible — security depends on key strength |
| Cache persistence | Decrypted content in Cache API until `/__lock` or browser clear |
| Cross-origin requests | Pass through to network (not intercepted by SW) |

**This is comparable to an encrypted ZIP on a public server.** Strong for keeping content private at rest on a public host. Not sufficient against a determined attacker with a weak key or physical device access.

## Hosting

The service worker requires **HTTPS**. Options:

- **GitHub Pages** — free, HTTPS built in, use the GitHub Action above
- **S3 + CloudFront** — put the 4 files in an S3 bucket behind CloudFront (free tier covers it)
- **Any static host with HTTPS** — Netlify, Vercel, etc.

## Project structure

```
build/pack.mjs       Build script — packs files into encrypted DuckDB (native encryption)
client/index.html    Loader — key prompt, DuckDB-Wasm init, cache population
client/sw.js         Service worker — cache-first fetch interception
client/404.html      GitHub Pages SPA redirect for cold-start deep links
src/                 Sample site content
dist/                Build output (4 files: index.html, sw.js, 404.html, site.duckdb)
action.yml           GitHub Action for use in other repos
```
