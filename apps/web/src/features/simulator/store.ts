/**
 * Simulator store — two independent concerns, one unified store.
 *
 * Lifecycle separation (Hickey: "Simple is disentangled"):
 *
 * 1. SESSION PLANE (Electron IPC) — created by user Start, destroyed by user Stop
 *    or app close.  Nothing in React controls its lifetime.
 *
 * 2. DISPLAY PLANE (this store) — per-workspace phase + full session metadata.
 *    Persists across workspace switches so the component can remount without
 *    re-probing via IPC.  SimulatorPanel writes here; ContentTabBar reads the
 *    phase label; any future viewer reads the stream URL directly.
 *
 * The component plane (SimulatorPanel mount/unmount) is NOT represented here —
 * it is purely ephemeral React rendering.  Workspace switch unmounts the
 * component but leaves this store untouched → session survives → on remount
 * the component reads existing state and reconnects with zero IPC round-trip.
 *
 * DESIGN RULE: `clearWorkspaceSession` is called ONLY on explicit user Stop or
 * when `stop_streaming` succeeds.  It is NEVER called from a component's
 * useEffect cleanup return.  That is the key invariant keeping the three
 * planes disentangled.
 *
 * STATE MACHINE: All transitions are validated by the pure `transition()`
 * function in machine.ts.  The `dispatch()` method is the primary write path.
 * Illegal transitions return null and are silently ignored (with a dev warning).
 * This prevents entire categories of stuck-state bugs.
 */

import { create } from "zustand";
import { transition } from "./machine";
import type { SimPhase, SimPhaseLabel, SimEvent } from "./machine";

// Re-export so consumers can import from store or machine.
export type { SimPhase, SimPhaseLabel, SimEvent };

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface SimulatorStore {
  /**
   * workspaceId → full phase discriminated union.
   *
   * Absent key is equivalent to { phase: "idle" }.  Idle entries are deleted
   * rather than stored so the map stays small.
   */
  sessions: Record<string, SimPhase>;

  /**
   * Dispatch a state machine event for a workspace.  Uses the pure
   * `transition()` function to compute the next phase.  If the transition
   * is illegal, it returns false (and logs a warning in dev).
   */
  dispatch: (workspaceId: string, event: SimEvent) => boolean;

  /**
   * Set the full phase for a workspace directly, bypassing the state machine.
   *
   * Prefer `dispatch()` for transitions within the normal lifecycle.
   * Use `setSession` only for recovery paths (mount probes, auto-reconnect)
   * where the event model doesn't apply because the transition comes from
   * observing external state (IPC session probe) rather than a user/agent action.
   */
  setSession: (workspaceId: string, phase: SimPhase) => void;

  /**
   * Remove the session record for a workspace (reverts to logical idle).
   *
   * Call ONLY from explicit Stop or confirmed stop_streaming success.
   * NEVER call from component useEffect cleanup — that would destroy the
   * session when the user switches workspaces (the complection we are
   * eliminating).
   */
  clearWorkspaceSession: (workspaceId: string) => void;

  /**
   * workspaceId → phase label (derived view of sessions for ContentTabBar).
   * Kept in sync automatically by setSession/dispatch/clearWorkspaceSession.
   */
  phases: Record<string, SimPhaseLabel>;
}

// Drop both maps' entries for a workspace. Centralizes the "idle keys are
// absent" invariant — every transition to idle must go through this.
function withoutWorkspace(state: SimulatorStore, workspaceId: string): Partial<SimulatorStore> {
  const { [workspaceId]: _s, ...sessions } = state.sessions;
  const { [workspaceId]: _p, ...phases } = state.phases;
  return { sessions, phases };
}

export const useSimulatorStatusStore = create<SimulatorStore>()((set, get) => ({
  sessions: {},
  phases: {},

  dispatch: (workspaceId, event) => {
    const current = get().sessions[workspaceId] ?? { phase: "idle" };
    const next = transition(current, event);

    if (next === null) {
      if (import.meta.env.DEV) {
        console.warn(`[SimStore] Illegal transition: ${current.phase} + ${event.type} → rejected`);
      }
      return false;
    }

    if (next.phase === "idle") {
      set((s) => withoutWorkspace(s, workspaceId));
    } else {
      set((s) => ({
        sessions: { ...s.sessions, [workspaceId]: next },
        phases: { ...s.phases, [workspaceId]: next.phase },
      }));
    }
    return true;
  },

  setSession: (workspaceId, phase) => {
    if (phase.phase === "idle") {
      set((s) => withoutWorkspace(s, workspaceId));
    } else {
      set((s) => ({
        sessions: { ...s.sessions, [workspaceId]: phase },
        phases: { ...s.phases, [workspaceId]: phase.phase },
      }));
    }
  },

  clearWorkspaceSession: (workspaceId) => set((s) => withoutWorkspace(s, workspaceId)),
}));

// ---------------------------------------------------------------------------
// Imperative accessors for use outside React render (async callbacks,
// event handlers, unmount guards).
// ---------------------------------------------------------------------------

export const simulatorStoreActions = {
  dispatch: (workspaceId: string, event: SimEvent) =>
    useSimulatorStatusStore.getState().dispatch(workspaceId, event),

  setSession: (workspaceId: string, phase: SimPhase) =>
    useSimulatorStatusStore.getState().setSession(workspaceId, phase),

  clearWorkspaceSession: (workspaceId: string) =>
    useSimulatorStatusStore.getState().clearWorkspaceSession(workspaceId),

  getSession: (workspaceId: string): SimPhase =>
    useSimulatorStatusStore.getState().sessions[workspaceId] ?? { phase: "idle" },

  /** UDIDs currently claimed by active sessions (excluding a given workspace). */
  getInUseUdids: (excludeWorkspaceId?: string): Set<string> => {
    const sessions = useSimulatorStatusStore.getState().sessions;
    const set = new Set<string>();
    for (const [wsId, phase] of Object.entries(sessions)) {
      if (wsId === excludeWorkspaceId) continue;
      if ("udid" in phase && phase.udid) set.add(phase.udid);
    }
    return set;
  },

  /** Find the workspace that owns a given UDID (excluding a workspace). */
  getWorkspaceByUdid: (udid: string, excludeWorkspaceId?: string): string | null => {
    const sessions = useSimulatorStatusStore.getState().sessions;
    for (const [wsId, phase] of Object.entries(sessions)) {
      if (wsId === excludeWorkspaceId) continue;
      if ("udid" in phase && phase.udid === udid) return wsId;
    }
    return null;
  },
};
