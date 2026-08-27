import { useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/shared/api/client";
import type { CloudPresence } from "../lib/cloudPresence";

/**
 * The honest "the sandbox isn't running" state for the Files and Terminal
 * panels. A paused/stopped sandbox has no sidecar, so the panels can't
 * function — instead of a frozen terminal that looks alive or a raw
 * SIDECAR_NOT_CONNECTED error, this says so plainly and offers the one action
 * that fixes it: wake. (Sending a chat message also wakes it — the copy says
 * so.) Waking rides the same POST /cloud-wake as the sidebar/header chip.
 */
export function CloudSandboxGate({
  workspaceId,
  presence,
}: {
  workspaceId: string;
  presence: Exclude<CloudPresence, "awake">;
}) {
  const [waking, setWaking] = useState(false);
  const isWaking = waking || presence === "waking";

  const wake = () => {
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
        {isWaking ? (
          <Loader2 className="text-text-muted h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Cloud className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
        )}
      </div>
      <p className="text-text-secondary text-sm font-medium">
        {isWaking ? "Waking the sandbox…" : "This sandbox is asleep"}
      </p>
      <p className="text-text-muted max-w-xs text-xs">
        {isWaking
          ? "It'll be ready in a moment."
          : "Wake it to browse files and use the terminal — or just send a message."}
      </p>
      {!isWaking && (
        <Button size="sm" onClick={wake}>
          Wake sandbox
        </Button>
      )}
    </div>
  );
}
