#!/usr/bin/env node
/**
 * pack.mjs — Build script that packs a site directory into an encrypted DuckDB file.
 *
 * Uses DuckDB's native AES-256-GCM block-level encryption (v1.4.0+). The CLI
 * creates an encrypted database directly — no manual encryption step needed.
 * At runtime, DuckDB-Wasm reads the encrypted file via HTTP range requests,
 * decrypting blocks on-demand with the user's key.
 *
 * Requires DuckDB CLI v1.4.4+ (uses OpenSSL for encrypted writes).
 * DuckDB-Wasm v1.32.0+ reads via MbedTLS (bundled in the WASM build).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ─── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { src: 'src', out: 'dist', key: null, base: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src' && argv[i + 1]) args.src = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === '--key' && argv[i + 1]) args.key = argv[++i];
    else if (argv[i] === '--base' && argv[i + 1]) args.base = argv[++i];
  }
  // Fall back to env vars only when flags not explicitly provided
  if (!args.key) args.key = process.env.VFS_KEY || null;
  if (args.base === null) args.base = process.env.VFS_BASE || '/';
  // Normalize: must be absolute and have trailing slash
  if (!args.base.startsWith('/')) args.base = '/' + args.base;
  if (!args.base.endsWith('/')) args.base += '/';
  if (!args.key) {
    console.error('Error: --key <encryption_key> or VFS_KEY env var is required');
    process.exit(1);
  }
  return args;
}

// ─── MIME type lookup ──────────────────────────────────────────────────────────

const MIME_MAP = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.pdf':  'application/pdf',
  '.xml':  'application/xml',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ─── Recursively walk a directory ──────────────────────────────────────────────

function walkDir(dir, base = dir) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkDir(fullPath, base));
    } else if (entry.isFile()) {
      // Normalize path to /-prefixed, forward slashes
      const relative = '/' + path.relative(base, fullPath).split(path.sep).join('/');
      entries.push({ vfsPath: relative, fullPath });
    }
  }
  return entries;
}

// ─── DuckDB CLI helper ─────────────────────────────────────────────────────────

function duckdbExec(dbPath, sql) {
  // Execute SQL via the DuckDB CLI — use execFileSync to avoid shell injection
  execFileSync('duckdb', [dbPath, sql], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
  });
}

// ─── Main build pipeline ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const srcDir = path.resolve(projectRoot, args.src);
  const outDir = path.resolve(projectRoot, args.out);

  if (!fs.existsSync(srcDir)) {
    console.error(`Error: source directory "${srcDir}" does not exist`);
    process.exit(1);
  }

  // Verify DuckDB CLI is available and >= v1.4.0 (native encryption support)
  try {
    const ver = execSync('duckdb --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const match = ver.match(/v(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      const [, major, minor] = match.map(Number);
      if (major < 1 || (major === 1 && minor < 4)) {
        console.error(`Error: DuckDB CLI ${ver} is too old. Need v1.4.0+ for native encryption.`);
        process.exit(1);
      }
    }
  } catch {
    console.error('Error: duckdb CLI not found. Install it via `brew install duckdb`.');
    process.exit(1);
  }

  // Ensure output directory exists
  fs.mkdirSync(outDir, { recursive: true });

  // Collect source files
  const files = walkDir(srcDir);
  if (files.length === 0) {
    console.error('Error: no files found in source directory');
    process.exit(1);
  }

  console.log(`\n  Packing ${files.length} files from ${args.src}/\n`);

  // ── Step 1: Create an encrypted DuckDB database via native encryption ──
  // Use os.tmpdir() so partial files never leak into dist/ on failure
  const tmpDbPath = path.join(os.tmpdir(), `_tmp_build_${process.pid}.duckdb`);
  const sqlTmpPath = path.join(os.tmpdir(), `_tmp_insert_${process.pid}.sql`);

  // Helper to escape single quotes in SQL string literals (' -> '')
  function sqlEscape(str) {
    return str.replace(/'/g, "''");
  }

  // Helper to clean up temp files
  function cleanupTempFiles() {
    for (const f of [tmpDbPath, tmpDbPath + '.wal', sqlTmpPath]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }

  // Clean up any previous temp DB
  cleanupTempFiles();

  let totalSize = 0;

  try {
    // ATTACH an encrypted database from :memory: — DuckDB CLI uses OpenSSL for writes
    const escapedKey = sqlEscape(args.key);
    duckdbExec(':memory:', `
      ATTACH '${sqlEscape(tmpDbPath)}' AS site (ENCRYPTION_KEY '${escapedKey}');
      CREATE TABLE site.vfs (
        path    VARCHAR PRIMARY KEY,
        mime    VARCHAR NOT NULL,
        content BLOB NOT NULL,
        size    BIGINT NOT NULL
      );
    `);

    // ── Step 2: Insert files into the encrypted database ──

    for (const file of files) {
      const content = fs.readFileSync(file.fullPath);
      const mime = getMime(file.fullPath);
      totalSize += content.length;

      // Convert binary content to hex string for BLOB insertion
      const hexContent = content.toString('hex');

      // Use a SQL file to avoid shell escaping issues with large blobs
      const escapedPath = sqlEscape(file.vfsPath);
      const escapedMime = sqlEscape(mime);
      const sql = `ATTACH '${sqlEscape(tmpDbPath)}' AS site (ENCRYPTION_KEY '${escapedKey}');
INSERT INTO site.vfs (path, mime, content, size) VALUES ('${escapedPath}', '${escapedMime}', from_hex('${hexContent}'), ${content.length});`;
      fs.writeFileSync(sqlTmpPath, sql);

      execFileSync('duckdb', [':memory:', `.read ${sqlTmpPath}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      try { fs.unlinkSync(sqlTmpPath); } catch { /* ignore */ }
      console.log(`    + ${file.vfsPath}  (${mime}, ${content.length} bytes)`);
    }

    // Verify insertion
    const countOutput = execFileSync('duckdb', [':memory:', `ATTACH '${sqlEscape(tmpDbPath)}' AS site (ENCRYPTION_KEY '${escapedKey}'); SELECT COUNT(*) FROM site.vfs;`], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    console.log(`\n  Inserted files into VFS (${totalSize} bytes total). Row count: ${countOutput}\n`);

    // ── Step 3: Copy encrypted DB directly to dist ──
    const encDbPath = path.join(outDir, 'site.duckdb');
    fs.copyFileSync(tmpDbPath, encDbPath);
    const dbSize = fs.statSync(encDbPath).size;
    console.log(`  Encrypted DB size: ${dbSize} bytes`);
    console.log(`  Written to: ${encDbPath}`);
  } finally {
    // ── Step 4: Clean up temp files (always, even on failure) ──
    cleanupTempFiles();
  }

  // ── Step 5: Copy client loader and service worker to dist ──
  // Compute a build-specific cache name from all shipped assets.
  // Covers DB content changes AND loader/SW code changes so any deploy
  // invalidates the cache. The browser checks for SW byte changes on each
  // navigation — a new hash triggers install → activate → old cache deleted.
  const encDbPath = path.join(outDir, 'site.duckdb');
  const buildHash = crypto.createHash('sha256');
  buildHash.update(fs.readFileSync(encDbPath));
  const loaderSrc = path.join(projectRoot, 'client', 'index.html');
  if (fs.existsSync(loaderSrc)) buildHash.update(fs.readFileSync(loaderSrc));
  const swSrc = path.join(projectRoot, 'client', 'sw.js');
  if (fs.existsSync(swSrc)) buildHash.update(fs.readFileSync(swSrc));
  const notFoundSrc = path.join(projectRoot, 'client', '404.html');
  if (fs.existsSync(notFoundSrc)) buildHash.update(fs.readFileSync(notFoundSrc));
  const cacheName = `vfs-cache-${buildHash.digest('hex').slice(0, 12)}`;

  // Copy loader to dist, injecting the build-specific cache name
  const loaderDst = path.join(outDir, 'index.html');
  if (fs.existsSync(loaderSrc)) {
    let loaderContent = fs.readFileSync(loaderSrc, 'utf8');
    loaderContent = loaderContent.replace('vfs-cache-v1', cacheName);
    fs.writeFileSync(loaderDst, loaderContent);
    console.log(`  Wrote loader: ${loaderDst}`);
  } else {
    console.warn('  Warning: client/index.html not found — skipping loader copy');
  }

  // Copy service worker to dist, injecting the same cache name
  const swDst = path.join(outDir, 'sw.js');
  if (fs.existsSync(swSrc)) {
    let swContent = fs.readFileSync(swSrc, 'utf8');
    swContent = swContent.replace('vfs-cache-v1', cacheName);
    fs.writeFileSync(swDst, swContent);
    console.log(`  Wrote service worker: ${swDst} (cache: ${cacheName})`);
  } else {
    console.warn('  Warning: client/sw.js not found — skipping service worker copy');
  }

  // Copy 404.html for GitHub Pages SPA deep-link support, injecting the base path
  const notFoundDst = path.join(outDir, '404.html');
  if (fs.existsSync(notFoundSrc)) {
    let notFoundContent = fs.readFileSync(notFoundSrc, 'utf8');
    notFoundContent = notFoundContent.replace(
      '</head>',
      `<meta name="vfs-base" content="${args.base}">\n</head>`
    );
    fs.writeFileSync(notFoundDst, notFoundContent);
    console.log(`  Wrote 404 redirect: ${notFoundDst} (base: ${args.base})`);
  } else {
    console.warn('  Warning: client/404.html not found — skipping 404 redirect copy');
  }

  // ── Summary ──
  const dbSize = fs.statSync(path.join(outDir, 'site.duckdb')).size;
  console.log('\n  ── Build Summary ──');
  console.log(`  Files packed:   ${files.length}`);
  console.log(`  Total size:     ${totalSize} bytes`);
  console.log(`  Encrypted DB:   ${dbSize} bytes`);
  console.log(`  Output dir:     ${outDir}/`);
  console.log(`  Output files:   index.html, sw.js, 404.html, site.duckdb`);
  console.log('  Done.\n');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
