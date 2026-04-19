// agent-server/agents/session-store.ts
// Generic typed session store — replaces the duplicated Map + get/set/delete
// boilerplate in claude-session.ts and codex-session.ts.
//
// Each agent instantiates its own SessionStore<T> with its session state type.
// The store provides a standard API plus an `owns()` guard for reference
// identity checks used in the catch/finally paths of streaming loops.

/**
 * Generic typed store for agent session state.
 *
 * Replaces the pattern of:
 *   const map = new Map<string, T>();
 *   export function get(id) { return map.get(id); }
 *   export function set(id, val) { map.set(id, val); }
 *   export function delete(id) { map.delete(id); }
 *
 * Each agent creates its own instance with its session state type:
 *   export const claudeSessions = new SessionStore<SessionState>();
 *   export const codexSessions = new SessionStore<CodexSessionState>();
 */
export class SessionStore<T> {
  private sessions = new Map<string, T>();

  get(id: string): T | undefined {
    return this.sessions.get(id);
  }

  set(id: string, state: T): void {
    this.sessions.set(id, state);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  clear(): void {
    this.sessions.clear();
  }

  /**
   * Iterate all stored values. Used by AAP app-registrar to broadcast
   * `setMcpServers` updates to every live Claude Query.
   */
  values(): IterableIterator<T> {
    return this.sessions.values();
  }

  /**
   * Check if the session reference matches (for ownership guards).
   *
   * Returns true when it's safe for the caller to mutate/clean up the session:
   * - No session exists for this id (nothing to clobber)
   * - The stored session is the same reference as `ref` (caller owns it)
   *
   * Returns false when a rapid re-query has replaced the session with a
   * different object — the caller's finally/catch block must NOT touch it.
   */
  owns(id: string, ref: T): boolean {
    if (!this.sessions.has(id)) return true;
    return this.sessions.get(id) === ref;
  }
}
