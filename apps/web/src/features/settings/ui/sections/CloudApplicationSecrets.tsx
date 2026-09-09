import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";
import { EnvironmentSecretDialog, type SecretAction } from "./EnvironmentSecretDialog";

export const ENVIRONMENT_SECRETS_QUERY_KEY = ["settings", "environment-secrets"] as const;

export function CloudApplicationSecrets({
  orgId,
  environmentId,
  settings: data,
  onDefaults,
}: {
  orgId: string;
  environmentId: string | null;
  settings: CloudEnvironmentSettings;
  onDefaults: () => void;
}) {
  const [action, setAction] = useState<SecretAction | null>(null);
  const queryClient = useQueryClient();
  const visible = data.secrets.filter(
    (secret) =>
      secret.appliesToAll || (environmentId && secret.environmentIds.includes(environmentId))
  );
  const missing = data.required.filter((item) => !item.source);
  return (
    <div className="space-y-4">
      {environmentId && data.required.length > 0 && (
        <div className="border-border-subtle space-y-2 border-b pb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Required values</p>
            <span className={`text-xs ${missing.length ? "text-warning" : "text-accent-green"}`}>
              {missing.length ? `${missing.length} missing` : "All values set"}
            </span>
          </div>
          {data.required.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3 text-xs">
              <span className="font-mono">{item.name}</span>
              {item.source ? (
                <span className="text-text-muted flex items-center gap-1">
                  <Check className="size-3" />
                  {item.source === "configuration" ? "Set in recipe" : "Set"}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => setAction({ type: "add", name: item.name })}
                >
                  Set value
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Secrets</p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setAction({ type: "add" })}>
            <Plus className="mr-1.5 size-3.5" />
            Add secret
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="text-text-muted text-sm">No secrets added yet.</p>
      ) : (
        <div className="divide-border-subtle divide-y">
          {visible.map((secret) => (
            <div
              key={secret.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs break-all">{secret.name}</p>
                <p className="text-text-muted mt-1 text-xs">
                  {secret.ownerType === "USER" ? "Personal" : "Shared"} ·{" "}
                  {secret.appliesToAll
                    ? "All repositories"
                    : secret.environmentIds.length > 1
                      ? `${secret.environmentIds.length} environments`
                      : "This repository"}
                </p>
              </div>
              {(!environmentId || !secret.appliesToAll) &&
                (secret.ownerType === "USER" || data.canManageShared) && (
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAction({ type: "replace", secret })}
                    >
                      Replace
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-text-muted hover:text-destructive"
                      onClick={() => setAction({ type: "delete", secret })}
                    >
                      Delete
                    </Button>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
      <p className="text-text-muted text-xs">
        Saved values are never shown again. Changes apply to new cloud workspaces.
      </p>
      {environmentId && (
        <button
          type="button"
          className="text-text-muted hover:text-text-primary text-xs underline underline-offset-4"
          onClick={onDefaults}
        >
          Manage secrets for all repositories
        </button>
      )}
      {action && (
        <EnvironmentSecretDialog
          key={`${environmentId}:${action.type}:${action.type === "add" ? (action.name ?? "") : action.secret.id}`}
          action={action}
          settings={data}
          orgId={orgId}
          environmentId={environmentId}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_SECRETS_QUERY_KEY });
          }}
        />
      )}
    </div>
  );
}
