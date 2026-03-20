import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TASK_ICON_NAMES, TASK_ICON_MAP, DEFAULT_TASK_ICON } from "@/shared/lib/taskIcons";
import type { TaskDraft } from "./manifest-draft";

interface TaskRowProps {
  task: TaskDraft;
  allTaskNames: string[];
  onChange: (task: TaskDraft) => void;
  onRemove: () => void;
}

export function TaskRow({ task, allTaskNames, onChange, onRemove }: TaskRowProps) {
  const rowId = useId();
  const [expanded, setExpanded] = useState(false);

  // Show a dot indicator when task has advanced config (visible when collapsed)
  const hasAdvanced =
    task.description ||
    task.icon !== DEFAULT_TASK_ICON ||
    task.persistent ||
    task.mode !== "concurrent" ||
    task.depends.length > 0 ||
    task.env.some((e) => e.key.trim());

  const IconComponent = TASK_ICON_MAP[task.icon];

  return (
    <div className="border-border-subtle rounded-lg border p-3">
      {/* Summary row */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Collapse task details" : "Expand task details"}
          className="text-text-muted hover:text-text-secondary relative transition-colors duration-200"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {!expanded && hasAdvanced && (
            <span className="bg-primary absolute -top-0.5 -right-0.5 size-1.5 rounded-full" />
          )}
        </button>
        {IconComponent && <IconComponent className="text-muted-foreground size-3.5 shrink-0" />}
        <Input
          value={task.name}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
          placeholder="Task name"
          className="max-w-[140px] text-sm font-medium"
        />
        <Input
          value={task.command}
          onChange={(e) => onChange({ ...task, command: e.target.value })}
          placeholder="Command"
          className="flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove task ${task.name || "unnamed"}`}
          className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 space-y-2 pl-6">
          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0 text-xs">Description</Label>
            <Input
              value={task.description}
              onChange={(e) => onChange({ ...task, description: e.target.value })}
              placeholder="What this task does"
              className="text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0 text-xs">Icon</Label>
            <Select value={task.icon} onValueChange={(v) => onChange({ ...task, icon: v })}>
              <SelectTrigger className="w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_ICON_NAMES.map((icon) => {
                  const Ic = TASK_ICON_MAP[icon];
                  return (
                    <SelectItem key={icon} value={icon} className="text-xs">
                      <span className="flex items-center gap-2">
                        {Ic && <Ic className="size-3" />}
                        {icon}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0 text-xs">Mode</Label>
            <Select
              value={task.mode}
              onValueChange={(v) =>
                onChange({ ...task, mode: v as "concurrent" | "nonconcurrent" })
              }
            >
              <SelectTrigger className="w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="concurrent" className="text-xs">
                  Concurrent
                </SelectItem>
                <SelectItem value="nonconcurrent" className="text-xs">
                  Non-concurrent
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor={`persistent-${rowId}`} className="w-20 shrink-0 text-xs">
              Persistent
            </Label>
            <Switch
              id={`persistent-${rowId}`}
              checked={task.persistent}
              onCheckedChange={(checked) => onChange({ ...task, persistent: checked })}
            />
          </div>

          {/* Dependencies */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="w-20 shrink-0 text-xs">Depends on</Label>
              <Select
                value=""
                onValueChange={(v) => {
                  if (!task.depends.includes(v)) {
                    onChange({ ...task, depends: [...task.depends, v] });
                  }
                }}
              >
                <SelectTrigger className="w-48 text-xs">
                  <SelectValue placeholder="Add dependency..." />
                </SelectTrigger>
                <SelectContent>
                  {allTaskNames
                    .filter((n) => n !== task.name && !task.depends.includes(n))
                    .map((n) => (
                      <SelectItem key={n} value={n} className="text-xs">
                        {n}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {task.depends.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-22">
                {task.depends.map((dep) => (
                  <span
                    key={dep}
                    className="bg-bg-muted text-text-secondary inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
                  >
                    {dep}
                    <button
                      type="button"
                      onClick={() =>
                        onChange({ ...task, depends: task.depends.filter((d) => d !== dep) })
                      }
                      aria-label={`Remove dependency ${dep}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Task-level env vars */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="w-20 shrink-0 text-xs">Env vars</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ...task,
                    env: [...task.env, { id: crypto.randomUUID(), key: "", value: "" }],
                  })
                }
                className="h-6 gap-1 px-1.5 text-xs"
              >
                <Plus className="size-2.5" />
                Add
              </Button>
            </div>
            {task.env.map((envVar) => (
              <div key={envVar.id} className="flex items-center gap-1.5 pl-22">
                <Input
                  value={envVar.key}
                  onChange={(e) => {
                    onChange({
                      ...task,
                      env: task.env.map((ev) =>
                        ev.id === envVar.id ? { ...ev, key: e.target.value } : ev
                      ),
                    });
                  }}
                  placeholder="KEY"
                  className="flex-1 font-mono text-xs"
                />
                <Input
                  value={envVar.value}
                  onChange={(e) => {
                    onChange({
                      ...task,
                      env: task.env.map((ev) =>
                        ev.id === envVar.id ? { ...ev, value: e.target.value } : ev
                      ),
                    });
                  }}
                  placeholder="value"
                  className="flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({ ...task, env: task.env.filter((ev) => ev.id !== envVar.id) })
                  }
                  aria-label={`Remove env var ${envVar.key || "unnamed"}`}
                  className="text-muted-foreground hover:text-destructive h-6 w-6 p-0"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
