/**
 * Commands the backend runs in a process group of their own (git, a project's
 * setup script), so a timeout can stop everything they started. A group
 * outlives the backend unless the backend stops it: a checkout or an install
 * left running would race the next start's cleanup of its workspace.
 */

const groups = new Set<number>();
let stopped = false;

/** Note a group while it runs. Call what this returns once it has finished. */
export function trackProcessGroup(pid: number | undefined): () => void {
  if (!pid) return () => {};
  groups.add(pid);
  return () => groups.delete(pid);
}

/**
 * For the backend's shutdown: ask every group still running to stop (git
 * removes what it had half made), and start no more, so a start that carries
 * on past a stopped command cannot begin another.
 */
export function stopProcessGroups(): void {
  stopped = true;
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** The backend is shutting down: its groups were stopped, and none starts. */
export function processGroupsStopped(): boolean {
  return stopped;
}
