/**
 * EnvironmentSection — per-repository opendevs.json manifest editor.
 *
 * Lets users select a repo, view/edit its opendevs.json configuration
 * (setup script, run script, archive script, requirements, env vars, tasks),
 * auto-detect from project files, and save.
 */

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
import { useRepos, useRepoManifest, useSaveRepoManifest } from "@/features/repository";
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

export function EnvironmentSection() {
  const { data: repos, isLoading: reposLoading } = useRepos();
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);

  // Auto-select first repo
  useEffect(() => {
    if (!selectedRepoId && repos && repos.length > 0) {
      setSelectedRepoId(repos[0].id);
    }
  }, [repos, selectedRepoId]);

  const { data: manifestData, isLoading: manifestLoading } = useRepoManifest(selectedRepoId);
  const saveMutation = useSaveRepoManifest();

  const [draft, setDraft] = useState<ManifestDraft>(EMPTY_DRAFT);
  const [isDirty, setIsDirty] = useState(false);
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);

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
    if (!selectedRepoId) return;
    const manifest = draftToManifest(draft);
    saveMutation.mutate(
      { repoId: selectedRepoId, manifest },
      {
        onSuccess: () => {
          toast.success("opendevs.json saved");
          setIsDirty(false);
        },
        onError: (err) => {
          toast.error(`Failed to save: ${err instanceof Error ? err.message : "Unknown error"}`);
        },
      }
    );
  }, [selectedRepoId, draft, saveMutation]);

  const handleReset = useCallback(() => {
    if (manifestData) {
      setDraft(manifestToDraft(manifestData.manifest));
      setIsDirty(false);
    }
  }, [manifestData]);

  const handleDetect = useCallback(async () => {
    if (!selectedRepoId) return;
    setDetecting(true);
    try {
      const { manifest } = await RepoService.detectManifest(selectedRepoId);
      setDraft(manifestToDraft(manifest));
      setIsDirty(true);
      toast.success("Detected project configuration");
    } catch (err) {
      toast.error(`Detection failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setDetecting(false);
    }
  }, [selectedRepoId]);

  const rawJson = useMemo(() => JSON.stringify(draftToManifest(draft), null, 2), [draft]);

  // Collect task names for dependency picker
  const taskNames = useMemo(() => draft.tasks.map((t) => t.name).filter(Boolean), [draft.tasks]);

  if (reposLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-base font-semibold">Environment</h3>
          <p className="text-muted-foreground mt-1 text-base">
            No repositories found. Add a project first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Environment</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Configure workspace setup, tasks, and environment for each repository.
        </p>
      </div>

      {/* Repo selector */}
      <div className="space-y-2">
        <Label htmlFor="repo-select" className="text-sm">
          Repository
        </Label>
        <Select value={selectedRepoId ?? ""} onValueChange={setSelectedRepoId}>
          <SelectTrigger id="repo-select" className="w-full">
            <SelectValue placeholder="Select a repository" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                {repo.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
                <p className="text-sm font-medium">No opendevs.json found</p>
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
              Runs automatically when a new workspace is created.
            </p>
            <Input
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
              Default dev server command for workspaces.
            </p>
            <Input
              id="run-script"
              value={draft.runScript}
              onChange={(e) => updateDraft("runScript", e.target.value)}
              placeholder="e.g. bun run dev"
            />
          </div>

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
              <p className="text-muted-foreground text-base">No tool requirements configured.</p>
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
              <Label className="text-sm">Environment variables</Label>
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
                  updateDraft("tasks", [...draft.tasks, { ...EMPTY_TASK, id: crypto.randomUUID() }])
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

          {/* Save / Reset / Generate */}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!isDirty || saveMutation.isPending} size="sm">
              {saveMutation.isPending && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              Save
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
          <WorkspaceStatusDashboard repoId={selectedRepoId} />
        </>
      )}
    </div>
  );
}
