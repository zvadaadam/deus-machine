import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processGroupsStopped, trackProcessGroup } from "@shared/lib/process-groups";

const graceMs = 1500;

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

/** Keep a parent-death pipe outside the group: even a SIGKILL of the backend closes its writer. */
function guardGroup(pid: number) {
  const guard = spawn(
    "/bin/sh",
    [
      "-c",
      'read -r done || { kill -TERM -- "-$1" 2>/dev/null || exit 0; sleep "$2"; kill -KILL -- "-$1" 2>/dev/null; }',
      "deus-device-group",
      String(pid),
      String(graceMs / 1000),
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    }
  );
  guard.stdin.on("error", () => {});
  return guard;
}

export function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  installing = false
) {
  signal.throwIfAborted();
  if (processGroupsStopped()) throw new Error("Deus is shutting down.");
  const runtime = process.env.DEUS_RUNTIME_EXECUTABLE;
  const child = spawn(runtime || "bun", args, {
    cwd,
    env: runtime ? { ...env, BUN_BE_BUN: "1" } : env,
    detached: true,
    stdio: ["ignore", "ignore", installing ? "pipe" : "ignore"],
  });
  const pid = child.pid;
  const forget = trackProcessGroup(pid);
  const guard = pid ? guardGroup(pid) : null;
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  let stopping: Promise<void> | undefined;
  async function stopGroup() {
    if (!pid || !signalGroup(pid, "SIGTERM")) return;
    const deadline = Date.now() + graceMs;
    while (signalGroup(pid, 0)) {
      if (Date.now() >= deadline) {
        signalGroup(pid, "SIGKILL");
        return;
      }
      await delay(50);
    }
  }
  const stop = () => (stopping ??= stopGroup());
  signal.addEventListener("abort", stop, { once: true });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, reason) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          stderr.trim().split("\n").slice(-8).join("\n") ||
            `Process exited with ${reason ?? "code " + code}.`
        )
      );
    });
  }).finally(async () => {
    signal.removeEventListener("abort", stop);
    // A helper can survive its group leader, including an ordinary hub exit.
    try {
      await stop();
    } finally {
      forget();
      guard?.stdin.end("stopped\n");
    }
  });
  return { child, closed };
}
