import {
  missingEnvironmentVariables,
  resolveProjectEnvironment,
  type ProjectEnvironment,
} from "@deus-hq/api";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/shared/api/queryKeys";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";
import { EnvironmentSecretDialog, type SecretAction } from "./EnvironmentSecretDialog";
import { ImportEnvironmentSecretsDialog } from "./ImportEnvironmentSecretsDialog";
import { parseEnvFile, type EnvFileEntry } from "../../lib/parse-env-file";

export function CloudApplicationSecrets({
  orgId,
  environmentId,
  repo,
  settings: data,
  project,
  onDefaults,
}: {
  orgId: string;
  environmentId: string | null;
  repo?: string;
  settings: CloudEnvironmentSettings;
  /** A supplied recipe is authoritative, including an empty requiredEnv list. */
  project?: ProjectEnvironment;
  onDefaults: () => void;
}) {
  const [action, setAction] = useState<SecretAction | null>(null);
  const [importEntries, setImportEntries] = useState<EnvFileEntry[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const reader = useRef<FileReader | null>(null);
  useEffect(() => () => reader.current?.abort(), []);
  const queryClient = useQueryClient();
  const isRepository = Boolean(environmentId || repo);
  const visible = data.secrets.filter(
    (secret) =>
      secret.appliesToAll || (environmentId && secret.environmentIds.includes(environmentId))
  );
  const resolved = project && resolveProjectEnvironment(project, "cloud");
  const required = resolved
    ? resolved.requiredEnv.map((name) => ({
        name,
        source: visible.some((secret) => secret.name === name)
          ? "secret"
          : missingEnvironmentVariables([name], resolved.env).length === 0
            ? "configuration"
            : null,
      }))
    : data.required;
  const missing = required.filter((item) => !item.source);
  function readFile(files: FileList | null) {
    if (!files?.length) return;
    setImportError(null);
    if (files.length !== 1 || files[0].size > 1_048_576) {
      setImportError("Choose one environment file smaller than 1 MB.");
      return;
    }
    reader.current?.abort();
    const next = new FileReader();
    reader.current = next;
    next.onload = () => {
      reader.current = null;
      try {
        setImportEntries(parseEnvFile(String(next.result)));
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Couldn't read environment file.");
      }
    };
    next.onerror = () => {
      reader.current = null;
      setImportError("Couldn't read the environment file.");
    };
    next.readAsText(files[0]);
  }
  function saved() {
    setAction(null);
    setImportEntries(null);
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.environments.all });
  }
  return (
    <div className="space-y-4">
      {isRepository && required.length > 0 && (
        <div className="border-border-subtle space-y-2 border-b pb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Required values</p>
            <span className={`text-xs ${missing.length ? "text-warning" : "text-accent-green"}`}>
              {missing.length ? `${missing.length} missing` : "All values set"}
            </span>
          </div>
          {required.map((item) => (
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
        <p className="text-sm font-medium">Cloud secrets</p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setAction({ type: "add" })}>
            <Plus className="mr-1.5 size-3.5" />
            Add secret
          </Button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        aria-label="Import environment file"
        onChange={(event) => {
          readFile(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="border-border-subtle text-text-muted hover:bg-bg-muted focus-visible:ring-ring w-full rounded-lg border border-dashed p-4 text-center text-xs focus-visible:ring-2"
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          readFile(event.dataTransfer.files);
        }}
      >
        Drop a .env or .dev.vars file, or click to import
      </button>
      {importError && (
        <p role="alert" className="text-destructive text-sm">
          {importError}
        </p>
      )}
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
              {(!isRepository || !secret.appliesToAll) &&
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
      {isRepository && (
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
          repo={repo}
          onClose={() => setAction(null)}
          onSaved={saved}
        />
      )}
      {importEntries && (
        <ImportEnvironmentSecretsDialog
          entries={importEntries}
          orgId={orgId}
          environmentId={environmentId}
          repo={repo}
          settings={data}
          onClose={() => setImportEntries(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
