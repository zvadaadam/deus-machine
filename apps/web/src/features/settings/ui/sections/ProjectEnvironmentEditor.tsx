import { useEffect, useId, useRef, useState } from "react";
import { ProjectEnvironmentSchema, type ProjectEnvironment } from "@deus-hq/api";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function ProjectEnvironmentEditor({
  project,
  sourceLabel,
  canEdit,
  canExport,
  onSave,
  onDirtyChange,
}: {
  project: ProjectEnvironment;
  sourceLabel: string;
  canEdit: boolean;
  canExport: boolean;
  onSave: (
    project: ProjectEnvironment,
    destination: "current" | "repository",
    signal: AbortSignal
  ) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(project);
  const [previousProject, setPreviousProject] = useState(project);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  if (project !== previousProject) {
    setPreviousProject(project);
    if (!dirty && !pending) setDraft(project);
  }
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  function change(next: ProjectEnvironment) {
    setDraft(next);
    setDirty(true);
    setSaved(false);
  }
  async function save(destination: "current" | "repository" = "current") {
    if (!form.current?.reportValidity()) return;
    const parsed = ProjectEnvironmentSchema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      await onSave(parsed.data, destination, controller.signal);
      if (!controller.signal.aborted) {
        setDraft(parsed.data);
        setDirty(false);
        setSaved(true);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Couldn't save setup.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <form
      ref={form}
      className="space-y-5"
      aria-label="Project environment"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-text-muted text-xs">{sourceLabel}</p>
      <fieldset disabled={!canEdit || pending} className="space-y-5">
        {(["setup", "run"] as const).map((key) => (
          <div key={key} className="space-y-2">
            <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
              {key === "setup" ? "Setup script" : "Run script"}
            </label>
            <p className="text-text-muted text-sm">
              {key === "setup"
                ? "Prepare new workspaces. Runs once after checkout, in your repository."
                : "Start your app. Runs automatically in cloud workspaces; use Run on your computer."}
            </p>
            <Textarea
              id={`${id}-${key}`}
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
              placeholder={key === "setup" ? "bun install" : "bun run dev"}
              value={draft[key] ?? ""}
              onChange={(event) => change({ ...draft, [key]: event.target.value || undefined })}
            />
          </div>
        ))}
        <details className="space-y-4" open={!!project.local || !!project.cloud}>
          <summary className="text-text-muted cursor-pointer text-sm">
            Customize for local or cloud
          </summary>
          <p className="text-text-muted text-xs">
            Both use the scripts above unless you change a command here.
          </p>
          {(["local", "cloud"] as const).map((target) => (
            <div key={target} className="border-border-subtle space-y-3 rounded-lg border p-4">
              <h5 className="text-sm font-medium capitalize">{target}</h5>
              {(["setup", "run"] as const).map((key) => {
                const value = draft[target]?.[key];
                const update = (value: string | null | undefined) =>
                  change({ ...draft, [target]: { ...draft[target], [key]: value } });
                return (
                  <div key={key} className="space-y-2">
                    <label className="flex items-center justify-between gap-3 text-sm">
                      <span className="capitalize">{key}</span>
                      <select
                        aria-label={`${target} ${key} behavior`}
                        className="border-border-subtle bg-bg-base rounded-md border px-2 py-1 text-sm"
                        value={
                          value === undefined ? "shared" : value === null ? "disabled" : "custom"
                        }
                        onChange={(event) =>
                          update(
                            event.target.value === "shared"
                              ? undefined
                              : event.target.value === "disabled"
                                ? null
                                : (draft[key] ?? "")
                          )
                        }
                      >
                        <option value="shared">Use shared script</option>
                        <option value="custom">Custom script</option>
                        <option value="disabled">Don't run</option>
                      </select>
                    </label>
                    {typeof value === "string" && (
                      <Textarea
                        aria-label={`${target} ${key} script`}
                        className="min-h-20 font-mono text-xs"
                        value={value}
                        spellCheck={false}
                        onChange={(event) => update(event.target.value)}
                      />
                    )}
                  </div>
                );
              })}
              <p className="text-text-muted text-xs">
                Public variables for {target}. These override shared defaults.
              </p>
              <KeyValues
                label={`${target} variable`}
                values={draft[target]?.env ?? {}}
                onChange={(env) => change({ ...draft, [target]: { ...draft[target], env } })}
              />
              <label htmlFor={`${id}-${target}-required`} className="text-sm">
                Additional required variable names
              </label>
              <VariableNames
                id={`${id}-${target}-required`}
                label={`${target} required variable names`}
                values={draft[target]?.requiredEnv ?? []}
                onChange={(requiredEnv) =>
                  change({ ...draft, [target]: { ...draft[target], requiredEnv } })
                }
              />
            </div>
          ))}
        </details>
        <div className="border-border-subtle space-y-3 border-t pt-5">
          <h4 className="text-sm font-medium">Public environment variables</h4>
          <p className="text-text-muted text-xs">
            Non-secret defaults shared by local and cloud. Add API keys in Secrets below.
          </p>
          <KeyValues
            label="Variable"
            values={draft.env ?? {}}
            onChange={(env) => change({ ...draft, env })}
          />
          <label htmlFor={`${id}-required`} className="block text-sm">
            Required variable names
          </label>
          <VariableNames
            id={`${id}-required`}
            label="Required variable names"
            values={draft.requiredEnv ?? []}
            onChange={(requiredEnv) => change({ ...draft, requiredEnv })}
          />
        </div>
        <details className="space-y-3">
          <summary className="text-text-muted cursor-pointer text-sm">Additional commands</summary>
          <p className="text-text-muted text-xs">
            Available from the Run menu, such as test or lint.
          </p>
          <KeyValues
            label="Command"
            values={draft.tasks ?? {}}
            onChange={(tasks) => change({ ...draft, tasks })}
          />
        </details>
      </fieldset>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" type="submit" disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save setup"}
          </Button>
          {canExport && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => void save("repository")}
            >
              Save to repository
            </Button>
          )}
          <span className="text-text-muted text-xs" role="status">
            {dirty ? "Unsaved changes" : saved ? "Saved" : ""}
          </span>
        </div>
      )}
      <p className="text-text-muted text-xs">
        Changes apply when preparing a workspace. Saving does not restart a running or paused app.
      </p>
    </form>
  );
}

function KeyValues({
  label,
  values,
  onChange,
}: {
  label: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState(() => Object.entries(values));
  const [previous, setPrevious] = useState(values);
  if (previous !== values) {
    setPrevious(values);
    setRows(Object.entries(values));
  }
  function change(next: [string, string][]) {
    setRows(next);
    const record = Object.fromEntries(next);
    setPrevious(record);
    onChange(record);
  }
  return (
    <div className="space-y-2">
      {rows.map(([name, value], index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            required
            ref={(input) =>
              input?.setCustomValidity(
                rows.filter(([key]) => key === name).length > 1 ? "Use each name only once." : ""
              )
            }
            aria-label={`${label} ${index + 1} name`}
            className="w-1/3 font-mono text-xs"
            placeholder={label === "Variable" ? "PORT" : "test"}
            value={name}
            onChange={(event) =>
              change(rows.map((row, i) => (i === index ? [event.target.value, value] : row)))
            }
          />
          <Input
            aria-label={`${label} ${index + 1} value`}
            className="flex-1 font-mono text-xs"
            value={value}
            onChange={(event) =>
              change(rows.map((row, i) => (i === index ? [name, event.target.value] : row)))
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => change(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => change([...rows, ["", ""]])}>
        <Plus className="mr-1.5 size-3.5" />
        Add {label.toLowerCase()}
      </Button>
    </div>
  );
}

function VariableNames({
  id,
  label,
  values,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(", "));
  const [previous, setPrevious] = useState(values);
  if (previous !== values) {
    setPrevious(values);
    setText(values.join(", "));
  }
  return (
    <Input
      id={id}
      aria-label={label}
      className="font-mono text-xs"
      placeholder="DATABASE_URL, OPENAI_API_KEY"
      value={text}
      onChange={(event) => {
        const next = event.target.value.split(/[\s,]+/).filter(Boolean);
        setText(event.target.value);
        setPrevious(next);
        onChange(next);
      }}
    />
  );
}
