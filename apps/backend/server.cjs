#!/usr/bin/env node
// CJS bootstrap: re-launches with tsx ESM support, then runs the TS entry point.
// Preserves `node backend/server.cjs` interface for dev.sh and Electron main process.
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

// Resolve tsx/esm absolutely so the bootstrap works regardless of CWD
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const child = spawn(
  process.execPath,
  ['--import', tsxEsm, path.join(__dirname, 'src/server.ts')],
  { stdio: 'inherit', env: process.env }
);

child.on('error', (err) => {
  console.error('[BOOTSTRAP] Failed to start backend:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Remove custom handlers so re-raise hits the default (terminate)
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

process.on('SIGINT', () => {
  if (!child.killed) child.kill('SIGINT');
});
process.on('SIGTERM', () => {
  if (!child.killed) child.kill('SIGTERM');
});
