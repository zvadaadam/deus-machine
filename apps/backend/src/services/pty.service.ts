/**
 * PTY Service — Backend
 *
 * Manages pseudo-terminal sessions using node-pty.
 * What a terminal prints, and its end, go to the clients following it
 * (the `terminalOutput` stream).
 */

import type * as Pty from "node-pty";
import { createRequire } from "node:module";
import { terminalOutput } from "@shared/api/terminal";
import { publish } from "./streams";

// Active PTY sessions, keyed by client-provided ID
const sessions = new Map<string, Pty.IPty>();
let ptyModule: typeof Pty | null = null;
const requireModule = createRequire(import.meta.url);

function getPtyModule(): typeof Pty {
  ptyModule ??= requireModule("node-pty") as typeof Pty;
  return ptyModule;
}

// What a terminal prints and its end, to the clients following it. The cloud
// PTY relay (agent/cloud/driver.ts) emits through these too, so local and
// remote terminals are indistinguishable to xterm.
export function emitPtyData(id: string, bytes: number[]): void {
  publish(terminalOutput, { id }, { type: "data", data: bytes });
}

export function emitPtyExit(id: string, error?: string): void {
  publish(terminalOutput, { id }, { type: "exit", ...(error ? { error } : {}) });
}

export function spawnPty(args: {
  id: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const { id, command, args: cmdArgs, cols, rows, cwd } = args;

  if (sessions.has(id)) {
    throw new Error(`PTY session already exists: ${id}`);
  }

  const ptyProcess = getPtyModule().spawn(command, cmdArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd || process.env.HOME || "/",
    env:
      (args.env as Record<string, string> | undefined) ?? (process.env as Record<string, string>),
  });

  ptyProcess.onData((data: string) => emitPtyData(id, Array.from(Buffer.from(data))));
  ptyProcess.onExit(() => {
    sessions.delete(id);
    emitPtyExit(id);
  });

  sessions.set(id, ptyProcess);
  return id;
}

export function writeToPty(id: string, data: number[]): void {
  const session = sessions.get(id);
  if (!session) throw new Error(`PTY instance not found: ${id}`);
  session.write(Buffer.from(data).toString());
}

export function resizePty(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) throw new Error(`PTY instance not found: ${id}`);
  session.resize(cols, rows);
}

export function killPty(id: string): void {
  const session = sessions.get(id);
  if (!session) return; // Silently ignore — may have already exited
  session.kill();
  sessions.delete(id);
}

/** Clean up all PTY sessions. Called on shutdown. */
export function destroyAllPtySessions(): void {
  for (const [_id, session] of sessions) {
    try {
      session.kill();
    } catch {}
  }
  sessions.clear();
}
