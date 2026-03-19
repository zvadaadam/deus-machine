/**
 * PTY Service — Backend
 *
 * Manages pseudo-terminal sessions using node-pty.
 * PTY data and exit events are broadcast to all WS clients as q:event frames.
 */

import * as pty from "node-pty";
import { broadcast } from "./ws.service";

// Active PTY sessions, keyed by client-provided ID
const sessions = new Map<string, pty.IPty>();

/** Broadcast a q:event frame to all connected WS clients. */
function pushEvent(event: string, data: unknown): void {
  broadcast(JSON.stringify({ type: "q:event", event, data }));
}

export function spawnPty(args: {
  id: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
}): string {
  const { id, command, args: cmdArgs, cols, rows, cwd } = args;

  if (sessions.has(id)) {
    throw new Error(`PTY session already exists: ${id}`);
  }

  const ptyProcess = pty.spawn(command, cmdArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd || process.env.HOME || "/",
    env: process.env as Record<string, string>,
  });

  // Forward PTY output as q:event "pty-data"
  ptyProcess.onData((data: string) => {
    const bytes = Array.from(Buffer.from(data));
    pushEvent("pty-data", { id, data: bytes });
  });

  // Forward PTY exit as q:event "pty-exit"
  ptyProcess.onExit(() => {
    sessions.delete(id);
    pushEvent("pty-exit", { id });
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
    try { session.kill(); } catch {}
  }
  sessions.clear();
}
