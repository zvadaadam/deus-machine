import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCloudOrganizations } from "@/shared/hooks/useCloudOrganizations";
import { cloudNotReady } from "../../lib/section-organization";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useUIStore } from "@/shared/stores/uiStore";
import { getStoredModel } from "@/features/session/lib/modelPreference";
import { DEFAULT_MODEL, getAgentHarnessForModel, getModelId, modelLabel } from "@/shared/agents";
import { useModelLists } from "@/shared/hooks/useModelLists";
import { defaultProviderAccount } from "@shared/types/provider-account";
import { HARNESSES } from "@shared/harnesses";
import { useProviderAccounts } from "../../api/provider-accounts.queries";

export function SetUpEnvironmentWithAgent({
  repoId,
  location,
  organizationId,
  onBeforeStart,
}: {
  repoId?: string;
  location: "local" | "cloud";
  /** The organization the section shows: a cloud setup workspace starts there. */
  organizationId: string | null;
  onBeforeStart: () => boolean;
}) {
  const session = useDeusCloudSession();
  const organizations = useCloudOrganizations();
  const providers = useProviderAccounts();
  const requestEnvSetup = useUIStore((state) => state.requestEnvSetup);
  const model = getStoredModel() ?? DEFAULT_MODEL;
  const harness = getAgentHarnessForModel(model);
  const { cloudProvider: provider, label: agentLabel } = HARNESSES[harness];
  const label = modelLabel(
    useModelLists({ cloud: location === "cloud" }),
    harness,
    getModelId(model)
  );
  function setupProblem() {
    if (!repoId) return "Add this repository to Deus to start a setup workspace.";
    if (location === "local") return null;
    if (session.data?.vaultLocked) return "Unlock your keyring, then reopen Deus.";
    const notReady = cloudNotReady(organizations, organizationId);
    if (notReady) return notReady;
    if (!provider) return `${agentLabel} runs only on this computer.`;
    if (providers.isError) return "Couldn't check your AI accounts. Try again in AI Providers.";
    if (providers.isPending) return "Checking your AI accounts…";
    if (defaultProviderAccount(providers.data, provider)?.status === "connected") return null;
    const definition = providers.data.providers.find((entry) => entry.id === provider);
    return `Connect ${definition ? `a ${definition.name}` : "an"} account in AI Providers to use ${label}.`;
  }
  const blocked = setupProblem();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0" tabIndex={blocked ? 0 : undefined}>
          <Button
            size="sm"
            variant="outline"
            disabled={!!blocked}
            onClick={() => {
              if (repoId && onBeforeStart())
                requestEnvSetup({
                  repoId,
                  location,
                  model,
                  organizationId: location === "cloud" ? organizationId : null,
                });
            }}
          >
            <Bot className="mr-1.5 size-3.5" />
            Set up with agent
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {blocked ??
          `Start a ${location} workspace with ${label} to configure and test this environment.`}
      </TooltipContent>
    </Tooltip>
  );
}
