import { useEffect, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/shared/api/client";
import type { CloudGateStage } from "../lib/cloudPresence";

/**
 * The honest "your computer isn't ready" state for the Files, Changes and
 * Terminal panels — a paused/stopped/resuming or still-provisioning cloud
 * computer has no sidecar, so the panels would otherwise show a raw "WebSocket
 * not connected" / "Failed to start terminal". Three stages:
 *   - provisioning — first-time setup in flight; just wait (no action).
 *   - waking       — an explicit resume is in flight.
 *   - asleep       — paused/stopped; offer the one action that fixes it: wake.
 * Waking rides the same POST /cloud-wake as the sidebar/header chip. "computer"
 * is the product word for the sandbox — the user's own machine in the cloud.
 */
export function CloudSandboxGate({
  workspaceId,
  stage,
}: {
  workspaceId: string;
  stage: CloudGateStage;
}) {
  const [waking, setWaking] = useState(false);
  // `waking` bridges the window before the server echoes; `stage` is
  // authoritative. Deliberately never reset on success — a woken computer flips
  // the stage to serviceable, which UNMOUNTS this gate. (Provisioning has no
  // wake action, so `waking` never goes true there.)
  const isWaking = waking || stage === "waking";

  // A resume can succeed while its session channel never reconnects, leaving
  // init_stage stuck on "resuming" (presence "waking") with nothing to clear
  // it — an indefinite spinner. After a grace period, surface a retry so the
  // user is never stranded on a computer that isn't actually coming back.
  const [stalled, setStalled] = useState(false);
  // `attempt` bumps on every wake() so the grace timer reschedules per attempt.
  // Without it, a retry from the stalled state can't re-arm: isWaking is already
  // true (never reset on success), so an effect keyed on isWaking alone wouldn't
  // re-run — and a retry that also fails to reconnect would spin forever.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Clear a prior cycle's stalled flag when waking ends, so a later
    // server-driven re-wake (e.g. a chat message flips presence back to
    // "waking") gets its full grace period instead of showing retry instantly.
    if (!isWaking) {
      setStalled(false);
      return;
    }
    const t = setTimeout(() => setStalled(true), 30_000);
    return () => clearTimeout(t);
  }, [isWaking, attempt]);
  // `stalled` only means anything mid-wake; a fresh wake() resets it. Gating on
  // isWaking here keeps a stale flag from a prior cycle out of the asleep view.
  const showStalled = isWaking && stalled;
  // Provisioning spins too, but on its own — no wake action, no stall/retry.
  const showSpinner = stage === "provisioning" || (isWaking && !showStalled);

  const wake = () => {
    setStalled(false);
    setAttempt((n) => n + 1);
    setWaking(true);
    // cloud-wake answers 200 {ok:false} on a failed restart/resume (it restores
    // the workspace to asleep), so a rejected promise isn't the only failure —
    // reset the spinner and bring the button back unless the wake actually took.
    void apiClient
      .post<{ ok?: boolean }>(`/workspaces/${workspaceId}/cloud-wake`)
      .then((res) => {
        if (!res?.ok) setWaking(false);
      })
      .catch(() => setWaking(false));
  };

  return (
    <div className="bg-bg-base/95 flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center backdrop-blur-sm">
      <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        {showSpinner ? (
          <Loader2 className="text-text-muted h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Cloud className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
        )}
      </div>
      <p className="text-text-secondary text-sm font-medium">
        {stage === "provisioning"
          ? "Setting up your computer…"
          : showSpinner
            ? "Waking your computer…"
            : showStalled
              ? "Still waking your computer"
              : "This computer is asleep"}
      </p>
      <p className="text-text-muted max-w-xs text-xs">
        {stage === "provisioning"
          ? "Installing dependencies and cloning your repo — this only takes a moment."
          : showSpinner
            ? "It'll be ready in a moment."
            : showStalled
              ? "This is taking longer than usual — try again, or just send a message."
              : "Wake it to browse files and use the terminal — or just send a message."}
      </p>
      {!showSpinner && (
        <Button size="sm" onClick={wake}>
          {showStalled ? "Try again" : "Wake computer"}
        </Button>
      )}
    </div>
  );
}
