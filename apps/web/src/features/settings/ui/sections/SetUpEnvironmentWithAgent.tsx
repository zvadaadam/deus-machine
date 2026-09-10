import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useUIStore } from "@/shared/stores/uiStore";
import { getStoredModel } from "@/features/session/lib/modelPreference";
import { getAgentHarnessForModel, getModelLabel } from "@/shared/agents";
import { defaultProviderAccount } from "@shared/types/provider-account";
import { useProviderAccounts } from "../../api/provider-accounts.queries";

export function SetUpEnvironmentWithAgent({
  repoId,
  location,
  activeOrganization,
  onBeforeStart,
}: {
  repoId?: string;
  location: "local" | "cloud";
  activeOrganization: boolean;
  onBeforeStart: () => boolean;
}) {
  const session = useDeusCloudSession();
  const providers = useProviderAccounts();
  const requestEnvSetup = useUIStore((state) => state.requestEnvSetup);
  const model = getStoredModel();
  const provider = getAgentHarnessForModel(model) === "claude-code" ? "claude" : "codex";
  const cloudBlocked = !activeOrganization
    ? "Select your active organization to start a cloud workspace."
    : session.data?.vaultLocked
      ? "Unlock your keyring, then reopen Deus."
      : !session.data?.hasPlatformKey
        ? "Finish device setup in Settings → Cloud."
        : providers.isError
          ? "Couldn't check your AI accounts. Try again in AI Providers."
          : providers.isPending
            ? "Checking your AI accounts…"
            : defaultProviderAccount(providers.data, provider)?.status !== "connected"
              ? `Connect a ${provider === "claude" ? "Claude" : "Codex"} account in AI Providers to use ${getModelLabel(model)}.`
              : null;
  const blocked = !repoId
    ? "Add this repository to Deus to start a setup workspace."
    : location === "cloud"
      ? cloudBlocked
      : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0" tabIndex={blocked ? 0 : undefined}>
          <Button
            size="sm"
            variant="outline"
            disabled={!!blocked}
            onClick={() => {
              if (repoId && onBeforeStart()) requestEnvSetup({ repoId, location, model });
            }}
          >
            <Bot className="mr-1.5 size-3.5" />
            Set up with agent
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {blocked ??
          `Start a ${location} workspace with ${getModelLabel(model)} to configure and test this environment.`}
      </TooltipContent>
    </Tooltip>
  );
}
