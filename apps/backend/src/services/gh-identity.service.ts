import { resolveCliExecutable } from "@shared/lib/cli-path";
import { parseGhAuthStatus, type GhAuthAccount } from "@shared/lib/github";
import type { GhCliStatus } from "@shared/types/github";
import { spawn } from "node:child_process";
import os from "node:os";
import { AppError } from "../lib/errors";
import { ghChildEnv, runGh } from "./gh.service";

interface GhApiUser {
  login?: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

function parseGhApiUser(stdout: string): GhApiUser | null {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed as GhApiUser;
    return null;
  } catch {
    return null;
  }
}

/** The active github.com account of this computer's GitHub CLI. */
async function activeGhAccount(): Promise<GhAuthAccount> {
  const result = await runGh(
    ["auth", "status", "--hostname", "github.com", "--active", "--json", "hosts"],
    { cwd: os.homedir(), timeoutMs: 5000 }
  );
  return result.success ? parseGhAuthStatus(result.stdout) : { authenticated: false, login: null };
}

/**
 * Resolve the active gh CLI account: install state, auth state, login,
 * display name, and avatar. Runs `gh --version`, `gh auth status`, and
 * `gh api user` in two stages — auth is checked before hitting the GitHub
 * API. Tolerates `gh api user` failures (e.g. offline) by returning the
 * login from auth status alone.
 */
export async function getGhIdentity(): Promise<GhCliStatus> {
  const cwd = os.homedir();
  const versionResult = await runGh(["--version"], { cwd, timeoutMs: 2000 });
  if (!versionResult.success) return { isInstalled: false, isAuthenticated: false };

  const account = await activeGhAccount();
  if (!account.authenticated) return { isInstalled: true, isAuthenticated: false };

  const apiResult = await runGh(["api", "user"], { cwd, timeoutMs: 5000 });
  const user = apiResult.success ? parseGhApiUser(apiResult.stdout) : null;

  return {
    isInstalled: true,
    isAuthenticated: true,
    login: user?.login ?? account.login,
    displayName: user?.name ?? null,
    avatarUrl: user?.avatar_url ?? null,
    htmlUrl: user?.html_url ?? null,
  };
}

interface GhLogin {
  /** gh's one-time code and the page to enter it on. */
  code: Promise<{ code: string; url: string }>;
  /** Resolves once gh has signed in. */
  done: Promise<void>;
  finished: boolean;
}

/** The sign-in under way, or the last one. */
let login: GhLogin | null = null;

/**
 * Sign this computer's GitHub CLI in to github.com with GitHub's device flow
 * (`gh auth login --web`, which also copies the code to this computer's
 * clipboard). Outside a terminal gh opens no browser: it prints a one-time code
 * and the page to enter it on, and this answers with them, so any client can
 * show them. gh then waits for the person, ten minutes at most; `ghLoginDone`
 * waits with it. Asked again while one is under way, it answers that one's code.
 */
export function startGhLogin(): Promise<{ code: string; url: string }> {
  if (login && !login.finished) return login.code;
  const child = spawn(
    resolveCliExecutable("gh"),
    [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--clipboard",
    ],
    {
      cwd: os.homedir(),
      env: ghChildEnv(),
      timeout: 10 * 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  let showCode!: (value: { code: string; url: string }) => void;
  let failCode!: (error: Error) => void;
  const entry: GhLogin = {
    code: new Promise((resolve, reject) => ((showCode = resolve), (failCode = reject))),
    done: new Promise((resolve, reject) => {
      const fail = (message: string) => {
        const error = new AppError(502, message);
        failCode(error);
        reject(error);
      };
      child.on("error", (error: NodeJS.ErrnoException) =>
        fail(error.code === "ENOENT" ? "GitHub CLI not found" : error.message)
      );
      child.on("close", (status) => {
        entry.finished = true;
        const last = output.trim().split("\n").pop();
        if (status !== 0) {
          return fail(
            child.killed
              ? "GitHub sign-in timed out"
              : `GitHub sign-in did not complete: ${last || `gh exited with ${status}`}`
          );
        }
        failCode(new AppError(502, "GitHub CLI ended its sign-in without a one-time code"));
        resolve();
      });
    }),
    finished: false,
  };
  const read = (chunk: Buffer) => {
    output += chunk.toString();
    const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0];
    const url = /https:\/\/\S+/.exec(output)?.[0];
    if (code && url) showCode({ code, url });
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  // Nobody may wait for the end; its failure is then this sign-in's, not the process's.
  entry.done.catch(() => {});
  login = entry;
  return entry.code;
}

/** The end of the sign-in `startGhLogin` began. */
export function ghLoginDone(): Promise<void> {
  if (!login) throw new AppError(409, "No GitHub sign-in was started");
  return login.done;
}

/** Sign the active github.com account out of this computer's GitHub CLI. */
export async function logoutGh(): Promise<void> {
  const account = await activeGhAccount();
  if (!account.authenticated || !account.login) {
    throw new AppError(409, "No active GitHub CLI account found");
  }
  const result = await runGh(
    ["auth", "logout", "--hostname", "github.com", "--user", account.login],
    { cwd: os.homedir(), timeoutMs: 15_000 }
  );
  if (!result.success) {
    throw new AppError(
      502,
      result.error === "timeout"
        ? "GitHub sign-out timed out"
        : `GitHub sign-out did not complete: ${result.message}`
    );
  }
}
