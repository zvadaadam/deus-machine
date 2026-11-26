import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { processGroupsStopped, trackProcessGroup } from "@shared/lib/process-groups";

const graceMs = 1500;

/** On macOS, kill(-pgid, …) succeeds while the hub group has a live member. When nothing can be
 *  signalled, EPERM means only exited, unreaped members remain and ESRCH means the group is empty. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      console.warn(`[DeviceHub] Could not signal process group ${pid}:`, error);
    }
    return false;
  }
}

async function stopGroup(pid: number | undefined) {
  if (!pid || !signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      signalGroup(pid, "SIGKILL");
      while (signalGroup(pid, 0)) await delay(50);
      return;
    }
    await delay(50);
  }
}

/** Keep a parent-death pipe outside the group: even a SIGKILL of the backend closes its writer. */
function guardGroup(pid: number, directory: string) {
  const guard = spawn(
    "/bin/sh",
    [
      "-c",
      `if ! read -r result && kill -TERM "-$1" 2>/dev/null; then
         sleep "$2"
         kill -KILL "-$1" 2>/dev/null
         while kill -0 "-$1" 2>/dev/null; do sleep 0.05; done
       fi
       if [ "$result" != "installed" ]; then rm -rf -- "$3"; fi`,
      "deus-device-group",
      String(pid),
      String(graceMs / 1000),
      directory,
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    }
  );
  guard.stdin.on("error", () => {});
  return { stdin: guard.stdin, closed: once(guard, "close") };
}

export function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  { directory, installing }: { directory: string; installing?: boolean }
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
  const guard = pid ? guardGroup(pid, directory) : null;
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= stopGroup(pid));
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
      guard?.stdin.end(installing ? "installed\n" : "stopped\n");
      await guard?.closed;
    }
  });
  return { child, closed };
}
