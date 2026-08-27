/**
 * Terminal Task Store
 *
 * Tiny Zustand store for queuing task commands that should open in a new terminal tab.
 * MainContent queues a task here, TerminalPanel consumes it and opens a new tab.
 */

import { create } from "zustand";

interface PendingTask {
  title: string;
  command: string;
}

interface TerminalTaskStore {
  /** One pending task PER workspace. A task runs in its own workspace's
   *  terminal, so keying by workspace (a) stops a hidden/frozen panel from
   *  running it in the wrong repo and (b) lets a task queued for an inactive
   *  workspace (e.g. an asleep cloud computer whose panel isn't mounted) wait
   *  for that workspace without another workspace's task clobbering it. */
  pendingTasks: Record<string, PendingTask>;
}

export const useTerminalTaskStore = create<TerminalTaskStore>(() => ({
  pendingTasks: {},
}));

/** Queue a task command to be opened in a new terminal tab for `workspaceId` */
export function queueTerminalTask(workspaceId: string, title: string, command: string) {
  useTerminalTaskStore.setState((s) => ({
    pendingTasks: { ...s.pendingTasks, [workspaceId]: { title, command } },
  }));
}

/** Consume the pending task for `workspaceId` (called by that workspace's
 *  TerminalPanel after creating the tab). */
export function consumeTerminalTask(workspaceId: string): PendingTask | null {
  const task = useTerminalTaskStore.getState().pendingTasks[workspaceId];
  if (!task) return null;
  useTerminalTaskStore.setState((s) => {
    const { [workspaceId]: _drop, ...rest } = s.pendingTasks;
    return { pendingTasks: rest };
  });
  return task;
}
