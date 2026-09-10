import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type {
  CloudEnvironmentSettings,
  EnvironmentSecret,
} from "@shared/types/environment-secrets";
import {
  deleteEnvironmentSecret,
  saveEnvironmentSecret,
} from "../../api/environment-secrets.service";
import { repositoryLabel } from "../../lib/environment-repositories";

export type SecretAction =
  | { type: "add"; name?: string }
  | { type: "replace" | "delete"; secret: EnvironmentSecret };

export function EnvironmentSecretDialog({
  action,
  orgId,
  environmentId,
  repo,
  settings,
  onClose,
  onSaved,
}: {
  action: SecretAction;
  orgId: string;
  environmentId: string | null;
  repo?: string;
  settings: CloudEnvironmentSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = action.type === "add" ? null : action.secret;
  const [name, setName] = useState(
    existing?.name ?? (action.type === "add" ? (action.name ?? "") : "")
  );
  const [value, setValue] = useState("");
  const [ownerType, setOwnerType] = useState<"ORG" | "USER">(existing?.ownerType ?? "USER");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const removing = action.type === "delete";
  const scopeLabel = existing
    ? existing.appliesToAll
      ? "all repositories"
      : existing.environmentIds
          .map((id) => {
            const env = settings.environments.find((item) => item.id === id);
            return env?.repo ? repositoryLabel(env.repo) : (env?.name ?? "another repository");
          })
          .join(", ")
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      if (removing && existing)
        await deleteEnvironmentSecret(orgId, existing.id, controller.signal);
      else
        await saveEnvironmentSecret(
          orgId,
          name.trim(),
          {
            value,
            ownerType,
            appliesToAll: existing?.appliesToAll ?? (!environmentId && !repo),
            environmentIds:
              existing?.environmentIds ?? (environmentId === null ? [] : [environmentId!]),
            ...(!existing && !environmentId && repo ? { repo } : {}),
          },
          controller.signal
        );
      setValue("");
      if (!controller.signal.aborted) onSaved();
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Couldn't save the secret. Try again.");
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
            <DialogTitle>
              {removing ? "Delete secret" : existing ? "Replace secret value" : "Add secret"}
            </DialogTitle>
            <DialogDescription>
              {existing
                ? `${name} · ${ownerType === "USER" ? "Personal" : "Shared"} · ${scopeLabel}`
                : `For ${environmentId || repo ? "this repository" : "all repositories"}. Stored securely and supplied to new cloud workspaces.`}
            </DialogDescription>
          </DialogHeader>
          {removing ? (
            <p className="text-text-secondary text-sm">
              New cloud workspaces will no longer receive this value. Another value with the same
              name may take its place. Running apps keep their current values.
            </p>
          ) : (
            <>
              {!existing && (
                <div className="space-y-2">
                  <Label htmlFor="secret-name">Name</Label>
                  <Input
                    id="secret-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="ELEVENLABS_API_KEY"
                    pattern="[A-Za-z_][A-Za-z0-9_]*"
                    maxLength={128}
                    required
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="secret-value">{existing ? "New value" : "Value"}</Label>
                <Input
                  id="secret-value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  maxLength={10000}
                  required
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </div>
              {!existing && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="secret-owner">Available to</Label>
                    <Select
                      value={ownerType}
                      onValueChange={(next: "ORG" | "USER") => setOwnerType(next)}
                    >
                      <SelectTrigger id="secret-owner" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USER">Only me</SelectItem>
                        {settings.canManageShared &&
                          settings.environments.find((env) => env.id === environmentId)
                            ?.ownerType !== "USER" && (
                            <SelectItem value="ORG">Everyone in the organization</SelectItem>
                          )}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <p className="text-text-muted text-xs">
                Applies to newly provisioned cloud workspaces. Running apps keep their current
                values.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={removing ? "destructive" : "default"} disabled={pending}>
              {pending
                ? "Saving…"
                : removing
                  ? "Delete secret"
                  : existing
                    ? "Replace value"
                    : "Save secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
