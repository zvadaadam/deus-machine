/**
 * Connection state machine — Zustand store.
 *
 * States:
 *   CONNECTED     → healthy, all systems go
 *   GRACE_PERIOD  → WS just dropped, wait 2s before showing anything
 *   RECONNECTING  → 2-30s, show thin reconnecting bar
 *   DISCONNECTED  → 30s+, show full banner, dim content
 *
 * Escalation shortcuts:
 *   - If a sendCommand fails while in GRACE_PERIOD or RECONNECTING,
 *     immediately jump to DISCONNECTED (user tried to act).
 */

import { create } from "zustand";
import { forceReconnect } from "@/platform/ws";

const GRACE_MS = 2_000;
const ESCALATE_MS = 30_000;

export type ConnectionState = "connected" | "grace_period" | "reconnecting" | "disconnected";

interface ConnectionStore {
  state: ConnectionState;
  disconnectedAt: number | null;
  sendAttemptFailed: boolean;
  onConnected: () => void;
  onDisconnected: () => void;
  markSendAttemptFailed: () => void;
  retry: () => void;
}

// Module-level timer refs (not serializable, don't belong in store state)
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let escalateTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (escalateTimer) {
    clearTimeout(escalateTimer);
    escalateTimer = null;
  }
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  state: "connected",
  disconnectedAt: null,
  sendAttemptFailed: false,

  onConnected: () => {
    clearTimers();
    set({ state: "connected", disconnectedAt: null, sendAttemptFailed: false });
  },

  onDisconnected: () => {
    const current = get().state;
    // Don't re-enter if already in the active disconnection flow (grace/reconnecting).
    // Allow re-entry from "disconnected" so that Retry → forceReconnect → onclose
    // can restart the grace period.
    if (current === "grace_period" || current === "reconnecting") return;

    clearTimers();
    set({ state: "grace_period", disconnectedAt: Date.now(), sendAttemptFailed: false });

    graceTimer = setTimeout(() => {
      if (get().state !== "grace_period") return;

      set({ state: "reconnecting" });

      // Escalate to DISCONNECTED after ESCALATE_MS total from initial disconnect
      // (not from entering RECONNECTING). Accounts for time already in GRACE_PERIOD.
      const disconnectedAt = get().disconnectedAt;
      if (!disconnectedAt) return;

      const remaining = Math.max(0, ESCALATE_MS - (Date.now() - disconnectedAt));
      escalateTimer = setTimeout(() => {
        if (get().state === "reconnecting") {
          set({ state: "disconnected" });
        }
      }, remaining);
    }, GRACE_MS);
  },

  markSendAttemptFailed: () => {
    const current = get().state;
    if (current === "grace_period" || current === "reconnecting") {
      clearTimers();
      set({ state: "disconnected", sendAttemptFailed: true });
    }
  },

  retry: () => {
    // Reset to grace_period for immediate visual feedback (banner shows
    // "Reconnecting..." instead of staying stuck on "Connection lost").
    // When ws is null after 30s+, forceReconnect() skips notifyConnectionChange
    // because its if(ws) guard fails — so we must transition the store ourselves.
    clearTimers();
    set({ state: "grace_period", disconnectedAt: Date.now(), sendAttemptFailed: false });

    graceTimer = setTimeout(() => {
      if (get().state === "grace_period") {
        set({ state: "reconnecting" });
      }
    }, GRACE_MS);

    forceReconnect();
  },
}));
