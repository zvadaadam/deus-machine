/**
 * Terminal Task Store
 *
 * Tiny Zustand store for queuing task commands that should open in a new terminal tab.
 * MainContent queues a task here, TerminalPanel consumes it and opens a new tab.
 */

import { create } from "zustand";

interface PendingTask {
  /** The task runs in THIS workspace's terminal — only that panel may claim it,
   *  so a task queued while its workspace is inactive (e.g. an asleep cloud
   *  computer whose panel isn't mounted) can't be run in the wrong repo by
   *  whichever panel happens to be active next. */
  workspaceId: string;
  title: string;
  command: string;
}

interface TerminalTaskStore {
  pendingTask: PendingTask | null;
}

export const useTerminalTaskStore = create<TerminalTaskStore>(() => ({
  pendingTask: null,
}));

/** Queue a task command to be opened in a new terminal tab for `workspaceId` */
export function queueTerminalTask(workspaceId: string, title: string, command: string) {
  useTerminalTaskStore.setState({ pendingTask: { workspaceId, title, command } });
}

/** Consume the pending task IFF it belongs to `workspaceId` (called by that
 *  workspace's TerminalPanel after creating the tab). */
export function consumeTerminalTask(workspaceId: string): PendingTask | null {
  const task = useTerminalTaskStore.getState().pendingTask;
  if (task && task.workspaceId === workspaceId) {
    useTerminalTaskStore.setState({ pendingTask: null });
    return task;
  }
  return null;
}
