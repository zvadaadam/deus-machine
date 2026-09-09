import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useUIStore } from "@/shared/stores/uiStore";
import { defaultProviderAccount } from "@shared/types/provider-account";
import { useProviderAccounts } from "../../api/provider-accounts.queries";

export function SetUpEnvironmentWithAgent({ repoId }: { repoId: string }) {
  const session = useDeusCloudSession();
  const providers = useProviderAccounts();
  const requestEnvSetup = useUIStore((state) => state.requestEnvSetup);
  const blocked = session.data?.vaultLocked
    ? "Unlock your keyring, then reopen Deus."
    : !session.data?.hasPlatformKey
      ? "Finish device setup in Settings → Cloud."
      : providers.isError
        ? "Couldn't check your AI accounts. Try again in AI Providers."
        : providers.isPending
          ? "Checking your AI accounts…"
          : defaultProviderAccount(providers.data, "claude")?.status !== "connected"
            ? "Connect a Claude account in AI Providers to set up with an agent."
            : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-text-muted flex-1 text-sm">
        {blocked ?? "Let an agent install dependencies, verify the app and save its setup."}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={!!blocked}
        onClick={() => requestEnvSetup(repoId)}
      >
        <Bot className="mr-1.5 size-3.5" />
        Set up with agent
      </Button>
    </div>
  );
}
