/**
 * PTY Service — Backend
 *
 * Manages pseudo-terminal sessions: Bun's own terminal in the packaged app's
 * deus-runtime, node-pty under Node (`bun run dev`, the tests, the npm CLI).
 * node-pty cannot read its terminal under Bun, and Bun's has no Node twin.
 * What a terminal prints, and its end, go to the clients following it
 * (the `terminalOutput` stream).
 */

import type * as Pty from "node-pty";
import { createRequire } from "node:module";
import { terminalOutput } from "@shared/api/terminal";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { ConflictError, NotFoundError } from "../lib/errors";
import { publish } from "./streams";

/** A terminal as this service drives it, on either engine. */
export interface Terminal {
  write(data: number[]): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP, as node-pty sends: an interactive shell ignores SIGTERM. */
  kill(): void;
}

export interface TerminalSpec {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  onData(bytes: Uint8Array): void;
  /** The process ended; node-pty reports a signal too, Bun's terminal only the code. */
  onExit(exitCode: number | null): void;
}

export function openTerminal(spec: TerminalSpec): Terminal {
  const { command, args, cols, rows, cwd, env } = spec;
  if (process.versions.bun) {
    // Bun 1.3.6 can drop the output of a process that exits the instant it
    // writes it (a bare `/bin/echo`: 1 in 100 runs, most of them when many run
    // at once). A shell that prints and lives on, as the app's terminals are,
    // loses nothing; node-pty loses nothing in either case.
    const proc = Bun.spawn([command, ...args], {
      cwd,
      // Bun's `name` does not export TERM, as node-pty's does.
      env: { ...env, TERM: "xterm-256color" },
      terminal: { cols, rows, name: "xterm-256color", data: (_t, bytes) => spec.onData(bytes) },
    });
    void proc.exited.then((code) => {
      proc.terminal?.close();
      spec.onExit(code);
    });
    return {
      write: (data) => proc.terminal?.write(Uint8Array.from(data)),
      resize: (c, r) => proc.terminal?.resize(c, r),
      kill: () => proc.kill("SIGHUP"),
    };
  }
  const pty = (createRequire(import.meta.url)("node-pty") as typeof Pty).spawn(command, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });
  pty.onData((data) => spec.onData(Buffer.from(data)));
  pty.onExit(({ exitCode }) => spec.onExit(exitCode));
  return {
    write: (data) => pty.write(Buffer.from(data).toString()),
    resize: (c, r) => pty.resize(c, r),
    kill: () => pty.kill(),
  };
}

// Active PTY sessions, keyed by client-provided ID
const sessions = new Map<string, Terminal>();

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
    throw new ConflictError(`PTY session already exists: ${id}`);
  }

  const terminal = openTerminal({
    command,
    args: cmdArgs,
    cols,
    rows,
    cwd: cwd || process.env.HOME || "/",
    env: (args.env ?? createBackendChildEnv()) as Record<string, string>,
    onData: (bytes) => emitPtyData(id, Array.from(bytes)),
    onExit: () => {
      sessions.delete(id);
      emitPtyExit(id);
    },
  });

  sessions.set(id, terminal);
  return id;
}

export function writeToPty(id: string, data: number[]): void {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError(`PTY instance not found: ${id}`);
  session.write(data);
}

export function resizePty(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError(`PTY instance not found: ${id}`);
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
