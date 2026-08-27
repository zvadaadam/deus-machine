/**
 * AutomationEditor — the right panel of the split (board 46b): create + edit.
 * Prompt-first, schedule as presets (custom cron behind the last option).
 * Cloud-only: runs happen in Deus Cloud sandboxes (Claude models), so the
 * repository needs a git remote and there is no lane to pick.
 */

import { useState } from "react";
import { ChevronLeft, Cloud } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import {
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components/ui";
import { useRepos } from "@/features/repository/api";
import { AGENT_CONFIGS } from "@/shared/agents";
import type { Automation } from "@/shared/types";
import { useSaveAutomation } from "../api/automations.queries";
import { SCHEDULE_PRESETS, buildCron, parseSchedule, type ScheduleForm } from "../lib/schedule";

export interface EditorPrefill {
  name?: string;
  prompt?: string;
  cron?: string;
}

const CLAUDE_MODELS = AGENT_CONFIGS["claude-code"].models;

interface FormState {
  name: string;
  prompt: string;
  repositoryId: string;
  /** Engine model id (Claude — cloud sandboxes run claude-code). */
  model: string;
  schedule: ScheduleForm;
  sessionPolicy: "fresh_session" | "same_session";
}

function initialForm(automation: Automation | null, prefill?: EditorPrefill): FormState {
  if (automation) {
    return {
      name: automation.name,
      prompt: automation.prompt,
      repositoryId: automation.repository_id ?? "",
      model: automation.model ?? CLAUDE_MODELS[0].model,
      schedule: parseSchedule(automation.cron ?? "0 9 * * 1-5"),
      sessionPolicy: automation.session_policy,
    };
  }
  return {
    name: prefill?.name ?? "",
    prompt: prefill?.prompt ?? "",
    repositoryId: "",
    model: CLAUDE_MODELS[0].model,
    schedule: prefill?.cron
      ? parseSchedule(prefill.cron)
      : { preset: "weekdays", time: "09:00", cron: "" },
    sessionPolicy: "fresh_session",
  };
}

export function AutomationEditor({
  automation,
  prefill,
  onBack,
  onSaved,
}: {
  automation: Automation | null;
  prefill?: EditorPrefill;
  onBack: () => void;
  onSaved: (automation: Automation) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(automation, prefill));
  const reposQuery = useRepos();
  // Cloud sandboxes clone from the remote — a repo without one can't be a target.
  const repos = (reposQuery.data ?? []).filter((repo) => repo.git_origin_url);
  const save = useSaveAutomation();

  const patch = (update: Partial<FormState>) => setForm((f) => ({ ...f, ...update }));
  const patchSchedule = (update: Partial<ScheduleForm>) =>
    setForm((f) => ({ ...f, schedule: { ...f.schedule, ...update } }));

  const selectedPreset = SCHEDULE_PRESETS.find((p) => p.id === form.schedule.preset);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleSave = () => {
    save.mutate(
      {
        ...(automation ? { automationId: automation.id } : {}),
        repository_id: form.repositoryId,
        name: form.name,
        prompt: form.prompt,
        cron: buildCron(form.schedule),
        timezone,
        session_policy: form.sessionPolicy,
        model: form.model || null,
      },
      {
        onSuccess: (saved) => {
          toast.success(automation ? "Automation saved" : "Automation created");
          onSaved(saved);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      }
    );
  };

  const canSave =
    form.name.trim().length > 0 &&
    form.prompt.trim().length > 0 &&
    form.repositoryId.length > 0 &&
    (form.schedule.preset !== "custom" || form.schedule.cron.trim().length > 0);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between px-8 pt-5">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label="Back to automations"
            onClick={onBack}
            className="text-text-secondary hover:bg-foreground/[0.04] flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-text-primary text-base font-semibold">
            {automation ? "Edit automation" : "New automation"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : automation ? "Save changes" : "Create automation"}
          </Button>
        </div>
      </div>

      {/* Form */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-[18px] px-8 py-7">
          <div className="border-border-subtle bg-bg-elevated flex items-center gap-2.5 rounded-lg border px-3 py-2.5">
            <Cloud className="text-text-secondary h-[15px] w-[15px] shrink-0" />
            <span className="text-text-tertiary text-xs">
              Runs in your Deus Cloud sandbox on a schedule — even when this Mac is closed.
            </span>
          </div>

          <Field label="Prompt">
            <Textarea
              value={form.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              placeholder="What should the agent do? e.g. Review open PRs and leave comments on anything risky…"
              className="min-h-[120px]"
            />
          </Field>

          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Morning PR review"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Repository"
              hint={
                repos.length === 0 ? "Cloud automations need a repo with a git remote." : undefined
              }
            >
              <Select value={form.repositoryId} onValueChange={(v) => patch({ repositoryId: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a repository…" />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Model">
              <Select value={form.model} onValueChange={(v) => patch({ model: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {CLAUDE_MODELS.map((option) => (
                    <SelectItem key={option.model} value={option.model}>
                      Claude · {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Schedule" hint={`${timezone} · at least 5 minutes apart`}>
            <div className="flex gap-2">
              <Select
                value={form.schedule.preset}
                onValueChange={(v) => patchSchedule({ preset: v as ScheduleForm["preset"] })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPreset?.hasTime && (
                <Input
                  type="time"
                  value={form.schedule.time}
                  onChange={(e) => patchSchedule({ time: e.target.value })}
                  className="w-28"
                />
              )}
              {form.schedule.preset === "custom" && (
                <Input
                  value={form.schedule.cron}
                  onChange={(e) => patchSchedule({ cron: e.target.value })}
                  placeholder="0 9 * * 1-5"
                  className="w-40 font-mono"
                />
              )}
            </div>
          </Field>

          <Field label="Each run">
            <Select
              value={form.sessionPolicy}
              onValueChange={(v) => patch({ sessionPolicy: v as FormState["sessionPolicy"] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fresh_session">Fresh chat per run</SelectItem>
                <SelectItem value="same_session">Continue one chat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </ScrollArea>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-text-secondary text-sm font-medium">{label}</Label>
      {children}
      {hint && <span className="text-text-muted text-2xs">{hint}</span>}
    </div>
  );
}
