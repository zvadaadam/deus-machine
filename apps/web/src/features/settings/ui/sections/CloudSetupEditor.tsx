import { useEffect, useRef, useState } from "react";
import type { SetupStep } from "@deus-hq/api";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { saveCloudEnvironmentSetup } from "../../api/environment-secrets.service";

/** Edit the saved steps without flattening parallel branches or changing shell boundaries. */
export function CloudSetupEditor({
  orgId,
  environmentId,
  repo,
  setup,
  canEdit,
  onSaved,
  onDirtyChange,
}: {
  orgId: string;
  environmentId: string | null;
  repo: string | null;
  setup: SetupStep[];
  canEdit: boolean;
  onSaved: (id: string, setup: SetupStep[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(setup);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!dirty && !pending) setDraft(setup);
  }, [setup, dirty, pending]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  function change(next: SetupStep[]) {
    setDraft(next);
    setDirty(true);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!environmentId && !repo) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await saveCloudEnvironmentSetup(
        orgId,
        environmentId ? { environmentId } : { repo: repo! },
        draft,
        controller.signal
      );
      if (!controller.signal.aborted) {
        setDirty(false);
        onSaved(result.id, draft);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Couldn't save setup.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4" aria-label="Cloud setup">
      <div>
        <h4 className="text-sm font-medium">Setup script</h4>
        <p className="text-text-muted mt-1 text-sm">
          Installs dependencies and prepares new cloud workspaces. Each command runs in its own
          shell.
        </p>
      </div>
      <fieldset disabled={!canEdit || pending} className="space-y-4">
        {draft.map((step, index) => (
          <div key={index} className="space-y-2">
            {(step.phase === "pre-clone" || "parallel" in step) && (
              <p className="text-text-muted text-xs">
                {step.phase === "pre-clone"
                  ? "Before repository checkout"
                  : "After repository checkout"}
                {"parallel" in step ? " · Parallel steps" : ""}
              </p>
            )}
            {"commands" in step ? (
              <Commands
                label={`Setup step ${index + 1}`}
                commands={step.commands}
                onChange={(commands) =>
                  change(
                    commands.length
                      ? draft.map((s, i) => (i === index ? { ...step, commands } : s))
                      : draft.filter((_, i) => i !== index)
                  )
                }
              />
            ) : (
              step.parallel.map((commands, branch) => (
                <Commands
                  key={branch}
                  label={`Step ${index + 1}, parallel branch ${branch + 1}`}
                  commands={commands}
                  onChange={(next) => {
                    const parallel = step.parallel
                      .map((b, i) => (i === branch ? next : b))
                      .filter((b) => b.length);
                    change(
                      parallel.length
                        ? draft.map((s, i) =>
                            i !== index
                              ? s
                              : parallel.length === 1
                                ? { phase: step.phase, commands: parallel[0] }
                                : { ...step, parallel }
                          )
                        : draft.filter((_, i) => i !== index)
                    );
                  }}
                />
              ))
            )}
          </div>
        ))}
        {!draft.length && (
          <p className="text-text-muted text-sm">
            No setup commands. Add a command such as bun install.
          </p>
        )}
        {draft.length < 20 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => change([...draft, { commands: [""] }])}
          >
            <Plus className="mr-1.5 size-3.5" />
            Add command
          </Button>
        )}
      </fieldset>
      {!canEdit && (
        <p className="text-text-muted text-xs">
          An organization owner or admin can edit this setup.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || (!dirty && !!environmentId)}>
            {pending ? "Saving…" : "Save cloud setup"}
          </Button>
          {dirty && <span className="text-text-muted text-xs">Unsaved changes</span>}
        </div>
      )}
      <p className="text-text-muted text-xs">
        Changes apply to new cloud workspaces. Saving does not run the script.
      </p>
    </form>
  );
}

function Commands({
  commands,
  label,
  onChange,
}: {
  commands: string[];
  label: string;
  onChange: (commands: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {commands.map((command, index) => (
        <div key={index} className="flex items-start gap-2">
          <Textarea
            aria-label={`${label}, command ${index + 1}`}
            className="min-h-24 font-mono text-xs"
            value={command}
            spellCheck={false}
            maxLength={2048}
            required
            onChange={(event) =>
              onChange(commands.map((c, i) => (i === index ? event.target.value : c)))
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-text-muted"
            aria-label={`Remove ${label.toLowerCase()}, command ${index + 1}`}
            onClick={() => onChange(commands.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
