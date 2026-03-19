/**
 * Simulator state machine — pure transition function.
 *
 * Every legal transition in the system is encoded here. The component
 * dispatches events; this function computes the next phase. If a transition
 * is illegal (e.g., "start_streaming" while already "building"), the
 * function returns null and the caller ignores the event.
 *
 * Zero dependencies — no React, no Zustand, no Electron. Fully testable.
 *
 * State diagram:
 *   idle ──BOOT──→ booting ──STREAM_READY──→ streaming ──BUILD_START──→ building ──BUILD_SUCCESS──→ running
 *                                               ↑                                                     │
 *                                               └────────────APP_UNINSTALLED──────────────────────────┘
 *                                               ↑             BUILD_START (rebuild)                    │
 *                                               └─────────────────────────────────────────────────────┘
 *   Any active state ──STOP──→ idle
 *   Any active state ──ERROR──→ error ──BOOT (retry)──→ booting
 *   Any state ──CLEAR──→ idle (forced reset)
 */

import type { StreamInfo, InstalledApp } from "./types";

// ---------------------------------------------------------------------------
// Phase discriminated union
// ---------------------------------------------------------------------------

export type SimPhase =
  | { phase: "idle" }
  | { phase: "booting"; udid: string }
  | { phase: "streaming"; udid: string; stream: StreamInfo }
  | { phase: "building"; udid: string; stream: StreamInfo; startedAt: number }
  | { phase: "running"; udid: string; stream: StreamInfo; app: InstalledApp }
  | { phase: "error"; message: string; canRetry: boolean };

export type SimPhaseLabel = SimPhase["phase"];

// ---------------------------------------------------------------------------
// Events — the things that can happen
// ---------------------------------------------------------------------------

export type SimEvent =
  | { type: "BOOT"; udid: string }
  | { type: "STREAM_READY"; udid: string; stream: StreamInfo }
  | { type: "BUILD_START"; startedAt: number }
  | { type: "BUILD_SUCCESS"; app: InstalledApp }
  | { type: "APP_UNINSTALLED" }
  | { type: "STOP" }
  | { type: "ERROR"; message: string; canRetry: boolean }
  | { type: "CLEAR" };

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

/**
 * Pure transition: given current phase + event, return next phase.
 * Returns null if the transition is illegal (caller should ignore/warn).
 */
export function transition(current: SimPhase, event: SimEvent): SimPhase | null {
  switch (event.type) {
    case "BOOT":
      // Can only boot from idle or error (retry)
      if (current.phase === "idle" || current.phase === "error") {
        return { phase: "booting", udid: event.udid };
      }
      return null;

    case "STREAM_READY":
      // Must be booting the same UDID
      if (current.phase === "booting" && current.udid === event.udid) {
        return { phase: "streaming", udid: event.udid, stream: event.stream };
      }
      return null;

    case "BUILD_START":
      // Can build from streaming or running (rebuild)
      if (current.phase === "streaming" || current.phase === "running") {
        return {
          phase: "building",
          udid: current.udid,
          stream: current.stream,
          startedAt: event.startedAt,
        };
      }
      return null;

    case "BUILD_SUCCESS":
      // Must be building
      if (current.phase === "building") {
        return {
          phase: "running",
          udid: current.udid,
          stream: current.stream,
          app: event.app,
        };
      }
      return null;

    case "APP_UNINSTALLED":
      // Drop back to streaming (keep the stream alive)
      if (current.phase === "running") {
        return { phase: "streaming", udid: current.udid, stream: current.stream };
      }
      return null;

    case "STOP":
      // Can stop from any active state
      if (current.phase !== "idle") {
        return { phase: "idle" };
      }
      return null;

    case "ERROR":
      // Can error from any non-idle state
      if (current.phase !== "idle") {
        return { phase: "error", message: event.message, canRetry: event.canRetry };
      }
      return null;

    case "CLEAR":
      // Force reset to idle (used after explicit stop confirmation)
      return { phase: "idle" };

    default: {
      // Exhaustiveness check — if a new event type is added, TypeScript
      // will flag this line at compile time.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Guard helpers — predicates on phase for conditional UI/logic
// ---------------------------------------------------------------------------

/** Whether the phase has a live MJPEG stream (streaming, building, or running). */
export function hasStream(
  phase: SimPhase
): phase is
  | Extract<SimPhase, { phase: "streaming" }>
  | Extract<SimPhase, { phase: "building" }>
  | Extract<SimPhase, { phase: "running" }> {
  return phase.phase === "streaming" || phase.phase === "building" || phase.phase === "running";
}

/** Whether the phase has a UDID (booting, streaming, building, running). */
export function hasUdid(phase: SimPhase): phase is Extract<SimPhase, { udid: string }> {
  return "udid" in phase;
}
