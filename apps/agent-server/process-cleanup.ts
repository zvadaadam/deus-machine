// agent-server/process-cleanup.ts
// Process cleanup helpers for the agent-server runtime.

import { execFile } from "child_process";
import { getErrorMessage } from "@shared/lib/errors";

const PROCESS_EXIT_POLL_MS = 100;
const SIGTERM_TIMEOUT_MS = 5_000;
const SIGKILL_TIMEOUT_MS = 2_000;

export async function killChildProcesses(parentPid = process.pid): Promise<void> {
  const childPids = await findChildProcesses(parentPid);

  if (childPids.length === 0) {
    console.log("[CLEANUP] No child processes found");
    return;
  }

  console.log(`[CLEANUP] Found ${childPids.length} child processes: ${childPids.join(", ")}`);
  await Promise.all(childPids.map((pid) => terminateProcess(pid)));
}

function findChildProcesses(parentPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pgrep", ["-P", String(parentPid)], (error, stdout) => {
      if (error && getProcessExitCode(error) !== 1) {
        console.log(`[CLEANUP] Failed to enumerate child processes: ${getErrorMessage(error)}`);
        if (!stdout) {
          resolve([]);
          return;
        }
      }

      const childPids = parsePids(stdout);
      resolve(childPids);
    });
  });
}

function getProcessExitCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return (error as { code?: string | number }).code;
}

function isNoSuchProcess(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "ESRCH";
}

function parsePids(stdout: string): number[] {
  return stdout
    .trim()
    .split("\n")
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function terminateProcess(pid: number): Promise<void> {
  const terminated = sendSignal(pid, "SIGTERM");
  if (!terminated) return;

  if (await waitForProcessExit(pid, SIGTERM_TIMEOUT_MS)) {
    console.log(`[CLEANUP] Child PID ${pid} exited after SIGTERM`);
    return;
  }

  console.log(`[CLEANUP] Child PID ${pid} did not exit after SIGTERM, sending SIGKILL`);
  const killed = sendSignal(pid, "SIGKILL");
  if (!killed) return;

  if (await waitForProcessExit(pid, SIGKILL_TIMEOUT_MS)) {
    console.log(`[CLEANUP] Child PID ${pid} exited after SIGKILL`);
    return;
  }

  console.log(`[CLEANUP] Child PID ${pid} still running after SIGKILL timeout`);
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    console.log(`[CLEANUP] Sent ${signal} to child PID ${pid}`);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      console.log(`[CLEANUP] Child PID ${pid} already exited`);
    } else {
      console.log(
        `[CLEANUP] Failed to send ${signal} to child PID ${pid}: ${getErrorMessage(error)}`
      );
    }
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(PROCESS_EXIT_POLL_MS);
  }
  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
