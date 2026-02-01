#!/usr/bin/env node
// CJS bootstrap: re-launches with tsx ESM support, then runs the TS entry point.
// Preserves `node backend/server.cjs` interface for dev.sh and Rust backend.rs.
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', path.join(__dirname, 'src/server.ts')],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
