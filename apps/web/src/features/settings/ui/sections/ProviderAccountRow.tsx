import type { ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderAccount, ProviderDefinition } from "@shared/types/provider-account";

export function ProviderAccountRow({
  provider,
  account,
  isDefault,
  disabled,
  onReconnect,
  onDefault,
  onDisconnect,
}: {
  provider: ProviderDefinition;
  account: ProviderAccount;
  isDefault: boolean;
  disabled: boolean;
  onReconnect: (account: ProviderAccount) => void;
  onDefault: (id: string) => void;
  onDisconnect: (id: string) => void;
}): ReactElement {
  const isApiKey = account.authMethod === "api_key";
  const connected = account.status === "connected";
  const replacesToken = !isApiKey && Boolean(provider.subscriptionTokenSetup);
  const canReconnect = isApiKey || provider.authMethods.includes("subscription");
  let reconnectLabel = "Reconnect";
  if (isApiKey) reconnectLabel = "Replace key";
  if (replacesToken) reconnectLabel = "Replace token";
  const authLabel = isApiKey
    ? "API key"
    : `${provider.subscriptionName ?? provider.name} subscription`;

  return (
    <div
      role="group"
      aria-label={`${provider.name} account ${account.label}`}
      className="flex flex-wrap items-start justify-between gap-2 py-3"
    >
      <div className="min-w-0">
        <p className="text-text-primary flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{account.label}</span>
          {isDefault && <span className="text-text-muted text-xs font-normal">Default</span>}
        </p>
        <p className="text-text-muted mt-0.5 text-xs break-all">
          {[authLabel, account.email, account.planType].filter(Boolean).join(" · ")}
        </p>
        <p
          className={
            connected
              ? "text-accent-green mt-1 flex items-center gap-1 text-xs"
              : "text-accent-red-muted mt-1 text-xs"
          }
        >
          {connected && <Check className="size-3" />}
          {connected ? "Connected" : "Reconnect required"}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {canReconnect && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onReconnect(account)}
          >
            {reconnectLabel}
          </Button>
        )}
        {connected && !isDefault && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onDefault(account.id)}
          >
            Use by default
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onDisconnect(account.id)}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
