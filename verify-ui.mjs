#!/usr/bin/env node
// Runs the UI verification suite in one command.
//
// The checkers each drive a real browser against a locally served file, so a
// reviewer should not have to know which port each one expects. This starts a
// static server on the port a checker asks for, runs it, reports, and stops.
//
//   node verify-ui.mjs            # all four
//   node verify-ui.mjs landing    # just one
//
// Requires: npm install (playwright is a devDependency), and a browser once via
//   npx playwright install chromium

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// port -> checker file, read from each script so the two cannot drift apart
// Only checkers that pass from a clean checkout are wired up here.
// check-popup.cjs drives .pop-harness.html, which is deliberately untracked, so
// it fails with "ring does not paint" on any fresh clone. It stays in .gitignore
// rather than shipping a check a reviewer cannot pass.
const CHECKERS = [
  { file: 'check-landing.cjs', port: 8894 },
  { file: 'check-fixes.cjs', port: 8898 },
  { file: 'check-motion.cjs', port: 8899 },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

const only = process.argv[2];
const targets = only ? CHECKERS.filter((c) => c.file.includes(only)) : CHECKERS;
if (!targets.length) {
  console.error(`no checker matches "${only}"`);
  process.exit(1);
}

// If a port is already taken by a leftover server, say so instead of failing
// with a bare EADDRINUSE that reads like the checker is broken.
function serve(port) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'landing.html' : rel);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: { ...process.env, SHOT_DIR: join(ROOT, '.ui-shots') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

let failed = 0;
for (const { file, port } of targets) {
  let server;
  try {
    server = await serve(port);
  } catch (e) {
    console.error(`${file}: could not bind 127.0.0.1:${port} (${e.code || e.message})`);
    failed++;
    continue;
  }
  console.log(`\n=== ${file} (port ${port}) ===`);
  const { code, out } = await run(file);
  const text = out.trimEnd();
  if (text) console.log(text);
  console.log(code === 0 ? `${file}: PASS` : `${file}: FAIL (exit ${code})`);
  if (code !== 0) failed++;
  await new Promise((r) => server.close(r));
}

console.log(
  failed === 0
    ? `\nall ${targets.length} checkers passed`
    : `\n${failed} of ${targets.length} checkers failed`,
);
process.exit(failed === 0 ? 0 : 1);