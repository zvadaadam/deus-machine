import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, FileJson, ChevronDown, ChevronRight, Wand2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useRepoManifest, useSaveRepoManifest } from "@/features/repository";
import { RepoService } from "@/features/repository/api/repository.service";
import {
  EMPTY_TASK,
  EMPTY_DRAFT,
  manifestToDraft,
  draftToManifest,
  type ManifestDraft,
} from "./manifest-draft";
import { TaskRow } from "./TaskRow";
import { WorkspaceStatusDashboard } from "./WorkspaceStatusDashboard";
import { Textarea } from "@/components/ui/textarea";

export function LocalEnvironmentSettings({
  repoId,
  onDirtyChange,
}: {
  repoId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { data: manifestData, isLoading: manifestLoading } = useRepoManifest(repoId);
  const saveMutation = useSaveRepoManifest();

  const [draft, setDraft] = useState<ManifestDraft>(EMPTY_DRAFT);
  const [isDirty, setIsDirty] = useState(false);
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  // Sync draft from fetched manifest
  useEffect(() => {
    if (manifestData) {
      setDraft(manifestToDraft(manifestData.manifest));
      setIsDirty(false);
    }
  }, [manifestData]);

  const updateDraft = useCallback(
    <K extends keyof ManifestDraft>(key: K, value: ManifestDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
      setIsDirty(true);
    },
    []
  );

  const handleSave = useCallback(() => {
    const manifest = draftToManifest(draft);
    saveMutation.mutate(
      { repoId, manifest },
      {
        onSuccess: () => {
          toast.success("deus.json saved");
          setIsDirty(false);
        },
        onError: (err) => {
          toast.error(`Failed to save: ${err instanceof Error ? err.message : "Unknown error"}`);
        },
      }
    );
  }, [repoId, draft, saveMutation]);

  const handleReset = useCallback(() => {
    if (manifestData) {
      setDraft(manifestToDraft(manifestData.manifest));
      setIsDirty(false);
    }
  }, [manifestData]);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const { manifest } = await RepoService.detectManifest(repoId);
      setDraft(manifestToDraft(manifest));
      setIsDirty(true);
      toast.success("Detected project configuration");
    } catch (err) {
      toast.error(`Detection failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setDetecting(false);
    }
  }, [repoId]);

  const rawJson = useMemo(() => JSON.stringify(draftToManifest(draft), null, 2), [draft]);

  // Collect task names for dependency picker
  const taskNames = useMemo(() => draft.tasks.map((t) => t.name).filter(Boolean), [draft.tasks]);

  return (
    <div className="space-y-5">
      <p className="text-text-muted text-sm">
        Scripts and public variables are saved in this repository’s deus.json.
      </p>
      {manifestLoading ? (
        <div className="flex h-20 items-center justify-center">
          <Loader2 className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none" />
        </div>
      ) : (
        <>
          {/* Auto-detect button — shown when manifest is empty or doesn't exist */}
          {(!manifestData?.manifest || Object.keys(manifestData.manifest).length <= 1) && (
            <div className="border-border-subtle flex items-center gap-3 rounded-lg border border-dashed p-4">
              <Wand2 className="text-muted-foreground size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">No deus.json found</p>
                <p className="text-muted-foreground text-base">
                  Auto-detect tasks from your project files (package.json, Cargo.toml, etc.)
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleDetect}
                disabled={detecting}
                className="shrink-0"
              >
                {detecting && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
                )}
                Generate
              </Button>
            </div>
          )}

          <Separator />

          {/* Setup script */}
          <div className="space-y-2">
            <Label htmlFor="setup-script" className="text-sm">
              Setup script
            </Label>
            <p className="text-muted-foreground text-base">
              Runs when a local workspace is created.
            </p>
            <Textarea
              className="min-h-28 font-mono text-xs"
              spellCheck={false}
              id="setup-script"
              value={draft.setupScript}
              onChange={(e) => updateDraft("setupScript", e.target.value)}
              placeholder="e.g. bun install"
            />
          </div>

          {/* Run script */}
          <div className="space-y-2">
            <Label htmlFor="run-script" className="text-sm">
              Run script
            </Label>
            <p className="text-muted-foreground text-base">
              Starts the development server in a local workspace.
            </p>
            <Textarea
              className="font-mono text-xs"
              spellCheck={false}
              id="run-script"
              value={draft.runScript}
              onChange={(e) => updateDraft("runScript", e.target.value)}
              placeholder="e.g. bun run dev"
            />
          </div>

          <details className="border-border-subtle border-t pt-4">
            <summary className="text-text-secondary cursor-pointer text-sm font-medium">
              Advanced setup
            </summary>
            <div className="mt-5 space-y-5">
              {/* Archive script */}
              <div className="space-y-2">
                <Label htmlFor="archive-script" className="text-sm">
                  Archive script
                </Label>
                <p className="text-muted-foreground text-base">
                  Runs when a workspace is archived (cleanup, webhooks, etc.)
                </p>
                <Input
                  id="archive-script"
                  value={draft.archiveScript}
                  onChange={(e) => updateDraft("archiveScript", e.target.value)}
                  placeholder="e.g. ./scripts/cleanup.sh"
                />
              </div>

              {/* Run mode */}
              <div className="space-y-2">
                <Label htmlFor="run-mode" className="text-sm">
                  Run script mode
                </Label>
                <Select
                  value={draft.runScriptMode}
                  onValueChange={(v) =>
                    updateDraft("runScriptMode", v as "concurrent" | "nonconcurrent")
                  }
                >
                  <SelectTrigger id="run-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nonconcurrent">Non-concurrent (one at a time)</SelectItem>
                    <SelectItem value="concurrent">Concurrent (allow multiple)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              {/* Requirements */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Requirements</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateDraft("requires", [
                        ...draft.requires,
                        { id: crypto.randomUUID(), tool: "", version: "" },
                      ])
                    }
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    <Plus className="size-3" />
                    Add
                  </Button>
                </div>
                {draft.requires.length === 0 && (
                  <p className="text-muted-foreground text-base">
                    No tool requirements configured.
                  </p>
                )}
                {draft.requires.map((req, i) => (
                  <div key={req.id} className="flex items-center gap-2">
                    <Input
                      value={req.tool}
                      onChange={(e) => {
                        const next = [...draft.requires];
                        next[i] = { ...next[i], tool: e.target.value };
                        updateDraft("requires", next);
                      }}
                      placeholder="Tool (e.g. node)"
                      className="flex-1"
                    />
                    <Input
                      value={req.version}
                      onChange={(e) => {
                        const next = [...draft.requires];
                        next[i] = { ...next[i], version: e.target.value };
                        updateDraft("requires", next);
                      }}
                      placeholder="Version (e.g. >= 22)"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateDraft(
                          "requires",
                          draft.requires.filter((_, j) => j !== i)
                        )
                      }
                      className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              <Separator />

              {/* Environment Variables */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Public environment variables</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateDraft("env", [
                        ...draft.env,
                        { id: crypto.randomUUID(), key: "", value: "" },
                      ])
                    }
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    <Plus className="size-3" />
                    Add
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Saved in deus.json and committed with your code. Keep private keys in your local
                  environment; cloud secrets are managed on the Cloud tab.
                </p>
                {draft.env.length === 0 && (
                  <p className="text-muted-foreground text-base">
                    No environment variables configured.
                  </p>
                )}
                {draft.env.map((envVar, i) => (
                  <div key={envVar.id} className="flex items-center gap-2">
                    <Input
                      value={envVar.key}
                      onChange={(e) => {
                        const next = [...draft.env];
                        next[i] = { ...next[i], key: e.target.value };
                        updateDraft("env", next);
                      }}
                      placeholder="KEY"
                      className="flex-1 font-mono text-xs"
                    />
                    <Input
                      value={envVar.value}
                      onChange={(e) => {
                        const next = [...draft.env];
                        next[i] = { ...next[i], value: e.target.value };
                        updateDraft("env", next);
                      }}
                      placeholder="value"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateDraft(
                          "env",
                          draft.env.filter((_, j) => j !== i)
                        )
                      }
                      className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              <Separator />

              {/* Tasks */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Tasks</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateDraft("tasks", [
                        ...draft.tasks,
                        { ...EMPTY_TASK, id: crypto.randomUUID() },
                      ])
                    }
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    <Plus className="size-3" />
                    Add task
                  </Button>
                </div>
                {draft.tasks.length === 0 && (
                  <p className="text-muted-foreground text-base">
                    No tasks configured. Tasks appear as buttons in the workspace header.
                  </p>
                )}
                {draft.tasks.map((task, i) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    allTaskNames={taskNames}
                    onChange={(updated) => {
                      const next = [...draft.tasks];
                      next[i] = updated;
                      updateDraft("tasks", next);
                    }}
                    onRemove={() =>
                      updateDraft(
                        "tasks",
                        draft.tasks.filter((_, j) => j !== i)
                      )
                    }
                  />
                ))}
              </div>

              <Separator />

              {/* Raw JSON preview */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setRawJsonOpen(!rawJsonOpen)}
                  className="text-text-muted hover:text-text-secondary flex items-center gap-1.5 text-sm transition-colors duration-200"
                >
                  {rawJsonOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <FileJson className="size-3.5" />
                  <span>Raw JSON preview</span>
                </button>
                {rawJsonOpen && (
                  <pre className="bg-bg-muted text-text-secondary max-h-80 overflow-auto rounded-md p-3 text-xs">
                    {rawJson}
                  </pre>
                )}
              </div>

              <Separator />
            </div>
          </details>
          {/* Save / Reset / Generate */}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!isDirty || saveMutation.isPending} size="sm">
              {saveMutation.isPending && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              Save local setup
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset} disabled={!isDirty}>
              Reset
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDetect} disabled={detecting}>
              {detecting ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Wand2 className="mr-1.5 size-3.5" />
              )}
              Auto-detect
            </Button>
            {isDirty && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
          </div>

          <Separator />

          {/* Workspace Status */}
          <WorkspaceStatusDashboard repoId={repoId} />
        </>
      )}
    </div>
  );
}
