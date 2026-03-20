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
  pendingTask: PendingTask | null;
}

export const useTerminalTaskStore = create<TerminalTaskStore>(() => ({
  pendingTask: null,
}));

/** Queue a task command to be opened in a new terminal tab */
export function queueTerminalTask(title: string, command: string) {
  useTerminalTaskStore.setState({ pendingTask: { title, command } });
}

/** Consume the pending task (called by TerminalPanel after creating the tab) */
export function consumeTerminalTask(): PendingTask | null {
  const task = useTerminalTaskStore.getState().pendingTask;
  if (task) {
    useTerminalTaskStore.setState({ pendingTask: null });
  }
  return task;
}
