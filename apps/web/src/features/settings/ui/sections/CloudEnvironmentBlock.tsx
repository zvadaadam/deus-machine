/**
 * CloudEnvironmentBlock — the selected repo's cloud environment + the org list.
 *
 * Cloud environments are agent-authored: "Set up with agent" spins up a cloud
 * workspace on the repo whose first turn is the onboarding prompt — the agent
 * installs, verifies, and persists the recipe via agnt_configure_environment.
 * Every future cloud workspace for the repo then provisions from it.
 */

import { useQuery } from "@tanstack/react-query";
import { Bot, Check, Cloud } from "lucide-react";
import { apiClient } from "@/shared/api/client";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/shared/stores/uiStore";

interface CloudEnvironmentInfo {
  configured: boolean;
  name: string | null;
  requiredEnv?: string[];
  lookupFailed?: true;
}

export function CloudEnvironmentBlock({
  repoId,
  cloudBlockedReason = null,
}: {
  repoId: string | null;
  /** Why the cloud lane can't provision, or null when it can. */
  cloudBlockedReason?: string | null;
}) {
  const requestEnvSetup = useUIStore((s) => s.requestEnvSetup);

  const info = useQuery({
    queryKey: ["repo-cloud-environment", repoId],
    queryFn: () => apiClient.get<CloudEnvironmentInfo>(`/repos/${repoId}/cloud-environment`),
    enabled: Boolean(repoId),
    staleTime: 30_000,
    retry: false,
  });

  const configured = info.data?.configured ?? false;

  return (
    <div className="space-y-3">
      <div
        className={
          "border-border-subtle flex items-center gap-3 rounded-lg border p-4" +
          (configured ? "" : " border-dashed")
        }
      >
        <Cloud className="text-muted-foreground size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            Cloud environment
            {configured && (
              <span className="text-accent-green flex items-center gap-1 text-xs font-normal">
                <Check className="h-3 w-3" /> Recipe saved
              </span>
            )}
          </p>
          <p className="text-muted-foreground text-base">
            {info.isError || info.data?.lookupFailed
              ? "Couldn't check the saved cloud recipe. Try again shortly."
              : configured
                ? `Cloud workspaces on this repo provision from the saved recipe${
                    info.data?.requiredEnv?.length
                      ? " — check required values in Application secrets above"
                      : ""
                  }.`
                : "An agent onboards the codebase on a cloud computer — installs dependencies, verifies the setup, and saves the recipe so future cloud workspaces start ready. Take over in the workspace anytime."}
          </p>
          {cloudBlockedReason && (
            <p className="text-text-muted mt-1 text-xs">{cloudBlockedReason}</p>
          )}
        </div>
        {repoId && (
          <Button
            size="sm"
            variant={configured ? "outline" : "default"}
            className="shrink-0"
            // Setup provisions a real cloud workspace, so without the lane it
            // can only end in an error. The reason renders as visible text
            // below — a `title` on a disabled button never shows, since the
            // shared Button sets disabled:pointer-events-none.
            disabled={cloudBlockedReason !== null}
            onClick={() => requestEnvSetup(repoId)}
          >
            <Bot className="mr-1.5 h-3.5 w-3.5" />
            {configured ? "Reconfigure with agent" : "Set up with agent"}
          </Button>
        )}
      </div>
    </div>
  );
}
