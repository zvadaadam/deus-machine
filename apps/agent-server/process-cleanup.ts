// agent-server/process-cleanup.ts
// Process cleanup helpers for the agent-server runtime.

import { exec } from "child_process";
import { getErrorMessage } from "@shared/lib/errors";

export async function killChildProcesses(parentPid = process.pid): Promise<void> {
  return new Promise((resolve) => {
    exec(`/usr/bin/pgrep -P ${parentPid}`, (_error, stdout) => {
      const childPids = parsePids(stdout);

      if (childPids.length === 0) {
        console.log("[CLEANUP] No child processes found");
        resolve();
        return;
      }

      console.log(`[CLEANUP] Found ${childPids.length} child processes: ${childPids.join(", ")}`);
      for (const pid of childPids) {
        terminateProcess(pid);
      }
      resolve();
    });
  });
}

function parsePids(stdout: string): number[] {
  return stdout
    .trim()
    .split("\n")
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function terminateProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[CLEANUP] Sent SIGTERM to child PID ${pid}`);
  } catch (error) {
    console.log(`[CLEANUP] Failed to kill child PID ${pid}: ${getErrorMessage(error)}`);
  }
}
