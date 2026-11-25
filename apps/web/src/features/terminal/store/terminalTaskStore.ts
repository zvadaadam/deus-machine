/**
 * Terminal Task Store
 *
 * Ephemeral in-memory map of one-shot initial commands for terminal tabs
 * (e.g. project environment tasks like "Run app" or "Build").
 * Keyed by terminal tab ID — never persisted to localStorage.
 *
 * Commands are consumed atomically at PTY dispatch time so:
 * - A pre-dispatch `ptySpawn` failure retry still runs the command once.
 * - Unmounting/remounting (e.g. returning from Home) never re-runs a dispatched command.
 */

const initialCommands = new Map<string, string>();

/** Register a one-shot initial command for a newly created terminal tab. */
export function setTerminalInitialCommand(tabId: string, command: string): void {
  initialCommands.set(tabId, command);
}

/** Peek the pending initial command without consuming it. */
export function getTerminalInitialCommand(tabId: string): string | undefined {
  return initialCommands.get(tabId);
}

/** Atomically read and remove the initial command at dispatch time. */
export function consumeTerminalInitialCommand(tabId: string): string | undefined {
  const command = initialCommands.get(tabId);
  if (command !== undefined) {
    initialCommands.delete(tabId);
  }
  return command;
}

/** Remove any stored initial command when a terminal tab is closed. */
export function clearTerminalInitialCommand(tabId: string): void {
  initialCommands.delete(tabId);
}
