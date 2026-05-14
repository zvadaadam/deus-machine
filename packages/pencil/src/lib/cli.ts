// packages/pencil/src/lib/cli.ts
//
// Pencil CLI surface — discovery, env hardening, runner, and the small
// commands we shell out to (status, version, --list-models). The ops
// module wraps `spawnCli` with phase tracking; everything else is direct.

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { PENCIL_PROD_API_BASE, STDERR_TAIL_BYTES } from "./config.ts";
import { resolveCliKey } from "./auth.ts";
import type { CliErrorParse, CliResult, CliVerifyResult, Context, Op } from "./types.ts";

// ---- discovery ------------------------------------------------------------

/** The bundled CLI is a workspace dep; bun hoists it to repo root. We
 *  resolve via require so the path is correct regardless of where this
 *  bundle is loaded from. */
export function findPencilCli(): { command: string; args: string[] } {
  try {
    const pkgJson = require.resolve("@pencil.dev/cli/package.json");
    const entry = join(dirname(pkgJson), "dist", "index.cjs");
    if (fs.existsSync(entry)) return { command: "node", args: [entry] };
  } catch {
    /* fall through */
  }
  return { command: "pencil", args: [] };
}

// ---- env hardening --------------------------------------------------------

/** Compose the env we hand to every CLI subprocess. Pinning two values
 *  matters: NODE_ENV=development from a dev shell silently routes the
 *  CLI to http://localhost:3001, and a stale PENCIL_API_BASE pointing at
 *  localhost has the same effect. */
export function buildCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };

  if (!env.PENCIL_API_BASE || /localhost|127\.0\.0\.1/.test(env.PENCIL_API_BASE)) {
    env.PENCIL_API_BASE = PENCIL_PROD_API_BASE;
  }
  if (env.NODE_ENV === "development" || !env.NODE_ENV) {
    env.NODE_ENV = "production";
  }
  if (!env.PENCIL_CLI_KEY || env.PENCIL_CLI_KEY.length === 0) {
    const resolved = resolveCliKey();
    if (resolved) env.PENCIL_CLI_KEY = resolved.key;
  }

  return env;
}

// ---- runner ---------------------------------------------------------------

function appendCappedTail(existing: string, chunk: string, max = STDERR_TAIL_BYTES): string {
  const next = existing + chunk;
  return next.length <= max ? next : next.slice(next.length - max);
}

export interface SpawnOpts {
  op?: Op;
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Run the CLI to completion. Resolves with stdout/stderr captured. */
export function spawnCli(
  extraArgs: string[],
  ctx: Context,
  { op, onChunk, env }: SpawnOpts = {}
): Promise<CliResult> {
  const cli = findPencilCli();
  const { workspace, storage } = ctx;
  return new Promise((resolve) => {
    fs.mkdirSync(join(storage, "designs"), { recursive: true });

    const child: ChildProcess = spawn(cli.command, [...cli.args, ...extraArgs], {
      cwd: workspace,
      env: buildCliEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (op) {
      op.child = child;
      op.pid = child.pid ?? null;
    }

    let stdout = "";
    let stderr = "";

    const pump = (stream: NodeJS.ReadableStream | null, kind: "stdout" | "stderr"): void => {
      if (!stream) return;
      stream.on("data", (c: Buffer | string) => {
        const chunk = c.toString();
        if (kind === "stdout") stdout = appendCappedTail(stdout, chunk);
        else stderr = appendCappedTail(stderr, chunk);
        // Mirror to the launcher's stdio so `bun run dev` sees CLI logs.
        process[kind === "stdout" ? "stdout" : "stderr"].write(`[pencil-cli] ${chunk}`);
        if (op) op.stderrTail = stderr;
        onChunk?.(kind, chunk);
      });
    };
    pump(child.stdout, "stdout");
    pump(child.stderr, "stderr");

    child.on("error", (err) => {
      resolve({
        ok: false,
        code: -1,
        signal: null,
        stdout,
        stderr: stderr + `\n${err.message}`,
      });
    });
    child.on("exit", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code ?? -1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

// ---- status / version / models -------------------------------------------

/** Round-trip a key against the Pencil API by running `pencil status`.
 *  Used to verify a freshly-pasted key before persisting. */
export async function verifyCliKey(key: string, ctx: Context): Promise<CliVerifyResult> {
  const result = await spawnCli(["status"], ctx, { env: { PENCIL_CLI_KEY: key } });
  if (!result.ok) {
    return {
      ok: false,
      error: parseStatusError(result.stdout + "\n" + result.stderr),
      raw: result.stdout + result.stderr,
    };
  }
  const clean = stripAnsi(result.stdout);
  const emailMatch = clean.match(/Email\s+([^\s]+@[^\s]+)/);
  return {
    ok: true,
    email: emailMatch?.[1] ?? null,
    raw: clean,
  };
}

let cachedVersion: string | null = null;
export async function getCliVersion(ctx: Context): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  const result = await spawnCli(["version"], ctx, {});
  if (!result.ok) {
    cachedVersion = "";
    return cachedVersion;
  }
  const clean = stripAnsi(result.stdout);
  const match = clean.match(/v?(\d+\.\d+\.\d+(?:[a-z0-9.-]*)?)/i);
  cachedVersion = match?.[1] ?? clean.trim();
  return cachedVersion;
}

// ---- error parsing --------------------------------------------------------

export function parseCliError(text: string): CliErrorParse {
  const clean = stripAnsi(text || "");
  if (/Authentication required/i.test(clean)) {
    return { code: "auth_missing", message: "Pencil CLI is not authenticated. Set a CLI key." };
  }
  if (/invalid|unauthorized|expired/i.test(clean) && /key|token|session/i.test(clean)) {
    return {
      code: "auth_invalid",
      message: "Pencil CLI key was rejected by the API. Check that it's not revoked.",
    };
  }
  if (/Failed to connect|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(clean)) {
    return {
      code: "network",
      message: "Couldn't reach the Pencil API. Check your network connection.",
    };
  }
  if (/ANTHROPIC_API_KEY/i.test(clean)) {
    return {
      code: "anthropic_key_missing",
      message:
        "The Pencil CLI needs an Anthropic API key (set ANTHROPIC_API_KEY) or a Claude Code subscription.",
    };
  }
  if (/rate.?limit|429|quota/i.test(clean)) {
    return {
      code: "rate_limit",
      message: "Anthropic rate-limited the request. Wait a moment and try again.",
    };
  }
  if (/Unknown model|model.*not found/i.test(clean)) {
    return {
      code: "model_not_found",
      message: "The requested model isn't available on this account.",
    };
  }
  const last = clean
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().length > 0)
    ?.replace(/^\[(INFO|WARN|ERROR|DEBUG)\]\s*/, "")
    .trim();
  return { code: "unknown", message: last || "Pencil CLI failed." };
}

function parseStatusError(text: string): string {
  const parsed = parseCliError(text);
  if (parsed.code === "auth_missing") {
    return "The CLI key is missing or empty. Paste a valid key.";
  }
  return parsed.message;
}

/** Strip ANSI color/style escape sequences from CLI output. */
export function stripAnsi(s: string): string {
  return String(s).replace(
    // eslint-disable-next-line no-control-regex
    /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]/g,
    ""
  );
}
