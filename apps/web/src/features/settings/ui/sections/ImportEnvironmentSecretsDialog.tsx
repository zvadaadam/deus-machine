import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";
import { importEnvironmentSecrets } from "../../api/environment-secrets.service";
import type { EnvFileEntry } from "../../lib/parse-env-file";

export function ImportEnvironmentSecretsDialog({
  entries,
  orgId,
  environmentId,
  repo,
  settings,
  onClose,
  onSaved,
}: {
  entries: EnvFileEntry[];
  orgId: string;
  environmentId: string | null;
  repo?: string;
  settings: CloudEnvironmentSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ownerType, setOwnerType] = useState<"USER" | "ORG">("USER");
  const [selected, setSelected] = useState(
    () => new Set(entries.filter(({ value }) => value.length > 0).map(({ name }) => name))
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const repository = Boolean(environmentId || repo);
  const scopedSecrets = settings.secrets.filter(
    (secret) =>
      secret.ownerType === ownerType &&
      (repository
        ? !secret.appliesToAll && environmentId && secret.environmentIds.includes(environmentId)
        : secret.appliesToAll)
  );
  const conflicts = new Set(
    scopedSecrets
      .filter((secret) => !secret.appliesToAll && secret.environmentIds.length > 1)
      .map((secret) => secret.name)
  );
  const replacements = new Set(scopedSecrets.map((secret) => secret.name));
  const selectedEntries = entries.filter(({ name }) => selected.has(name) && !conflicts.has(name));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      await importEnvironmentSecrets(
        orgId,
        {
          ownerType,
          appliesToAll: !repository,
          environmentIds: environmentId ? [environmentId] : [],
          ...(!environmentId && repo ? { repo } : {}),
        },
        selectedEntries,
        controller.signal
      );
      if (!controller.signal.aborted) onSaved();
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Couldn't import secrets.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Import environment variables</DialogTitle>
            <DialogDescription>
              Save selected values as secrets for{" "}
              {repository ? "this repository" : "all repositories"}. Nothing is written to your
              code. Empty values are left out.
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={pending} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="import-owner" className="text-sm font-medium">
                Available to
              </label>
              <Select
                value={ownerType}
                onValueChange={(value: "USER" | "ORG") => setOwnerType(value)}
              >
                <SelectTrigger id="import-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">Only me</SelectItem>
                  {settings.canManageShared &&
                    settings.environments.find((env) => env.id === environmentId)?.ownerType !==
                      "USER" && <SelectItem value="ORG">Everyone in the organization</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="border-border-subtle max-h-64 divide-y overflow-y-auto rounded-lg border">
              {entries.map(({ name, value }) => (
                <label key={name} className="flex items-center gap-3 p-3 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary size-4"
                    checked={selected.has(name) && !conflicts.has(name)}
                    disabled={!value || conflicts.has(name)}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(name);
                        else next.delete(name);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 font-mono break-all">{name}</span>
                  <span className="text-text-muted">
                    {!value
                      ? "Empty · skipped"
                      : conflicts.has(name)
                        ? "Multiple environments"
                        : replacements.has(name)
                          ? "Replace value"
                          : "Add"}
                  </span>
                </label>
              ))}
            </div>
            {entries.some(({ name }) => conflicts.has(name)) && (
              <p className="text-text-muted text-xs">
                Values used by multiple environments are skipped. Use Replace on the existing secret
                to update them together.
              </p>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !selectedEntries.length}>
              {pending
                ? "Importing…"
                : `Import ${selectedEntries.length} ${selectedEntries.length === 1 ? "secret" : "secrets"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
