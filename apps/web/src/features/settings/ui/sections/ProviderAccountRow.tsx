import { useState, type ReactElement } from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderAccount, ProviderDefinition } from "@shared/types/provider-account";

export function ProviderAccountRow({
  provider,
  account,
  isDefault,
  disabled,
  onReconnect,
  onDefault,
  onRename,
  onDisconnect,
}: {
  provider: ProviderDefinition;
  account: ProviderAccount;
  isDefault: boolean;
  disabled: boolean;
  onReconnect: (account: ProviderAccount) => void;
  onDefault: (id: string) => void;
  onRename: (id: string, label: string) => Promise<void>;
  onDisconnect: (id: string) => void;
}): ReactElement {
  const [editingName, setEditingName] = useState<string>();
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
        {editingName === undefined ? (
          <p className="text-text-primary flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{account.label}</span>
            {isDefault && <span className="text-text-muted text-xs font-normal">Default</span>}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Rename account"
              title="Rename account"
              disabled={disabled}
              onClick={() => setEditingName(account.label)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </p>
        ) : (
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !editingName.trim()) return;
              void onRename(account.id, editingName.trim()).then(
                () => setEditingName(undefined),
                () => {} // The parent reports the error; keep the name available to retry.
              );
            }}
          >
            <Input
              aria-label="Account name"
              autoFocus
              maxLength={80}
              value={editingName}
              onChange={(event) => setEditingName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !disabled) setEditingName(undefined);
              }}
              disabled={disabled}
              className="max-w-xs"
            />
            <Button size="sm" disabled={disabled || !editingName.trim()}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setEditingName(undefined)}
            >
              Cancel
            </Button>
          </form>
        )}
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
