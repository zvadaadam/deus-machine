import { useState, useEffect, createElement } from "react";
import { AlertCircle, FolderOpen, Loader2, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { onEvent } from "@/platform/ws/query-protocol-client";
import { GIT_INIT_PROGRESS, type GitInitProgressEvent } from "@shared/events";
import { native, capabilities } from "@/platform";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { cn } from "@/shared/lib/utils";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { useGhStatus } from "@/features/workspace/api";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "../lib/templates";
import type { StartNewProjectTemplate } from "@/app/layouts/hooks/useStartNewProject";

const MAX_LINES = 3;

interface StartNewProjectModalProps {
  show: boolean;
  creating: boolean;
  error: string | null;
  statusMessage?: string | null;
  onClose: () => void;
  onCreateProject: (
    projectName: string,
    targetPath: string,
    template?: StartNewProjectTemplate
  ) => void;
  onClearError: () => void;
}

export function StartNewProjectModal({
  show,
  creating,
  error,
  statusMessage,
  onClose,
  onCreateProject,
  onClearError,
}: StartNewProjectModalProps) {
  const isMobile = useIsMobile();
  const [projectName, setProjectName] = useState("");
  const [basePath, setBasePath] = useState("");
  const [defaultBasePath, setDefaultBasePath] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<ProjectTemplate>(PROJECT_TEMPLATES[0]);
  const [lines, setLines] = useState<string[]>([]);
  const githubUsername = useGhStatus().data?.login ?? null;

  // Resolve default destination path on mount
  useEffect(() => {
    if (!show) return;
    (async () => {
      const home = await native.dialog.getHomeDir();
      // getHomeDir returns "~" in web mode (no IPC) — don't use tilde as a path
      if (home && home !== "~") {
        setDefaultBasePath(isMobile ? `${home}/.deus/repos` : `${home}/Developer`);
      }
      if (isMobile) setBasePath("");
    })();
  }, [show, isMobile]);

  // Listen for git-init-progress events while creating
  useEffect(() => {
    if (!creating) return;
    const unlisten = onEvent((event, data) => {
      if (event === GIT_INIT_PROGRESS) {
        const { line } = data as GitInitProgressEvent;
        if (line) {
          setLines((prev) => [...prev, line].slice(-MAX_LINES));
        }
      }
    });
    return unlisten;
  }, [creating]);

  const effectiveBasePath = isMobile ? defaultBasePath : basePath.trim() || defaultBasePath;
  const fullPath = projectName.trim() ? `${effectiveBasePath}/${projectName.trim()}` : "";

  function handleCreate() {
    if (!projectName.trim()) return;
    onClearError();
    setLines([]);
    const template: StartNewProjectTemplate | undefined =
      selectedTemplate.type === "empty"
        ? undefined
        : { type: selectedTemplate.type, url: selectedTemplate.url };
    onCreateProject(projectName.trim(), fullPath, template);
  }

  const handleNameChange = (value: string) => {
    // Allow alphanumeric, dashes, underscores, dots — strip other chars
    const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "");
    setProjectName(sanitized);
    if (error) onClearError();
  };

  const handleClose = () => {
    setProjectName("");
    setBasePath("");
    setSelectedTemplate(PROJECT_TEMPLATES[0]);
    setLines([]);
    onClose();
  };

  const handleBrowse = async () => {
    try {
      const selected = await native.dialog.pickFolder();
      if (typeof selected === "string") {
        setBasePath(selected);
      }
    } catch (err) {
      console.error("Error opening folder picker:", err);
    }
  };

  return (
    <Dialog open={show} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Start New Project</DialogTitle>
          <DialogDescription className="text-text-muted text-xs">
            Create a new project from scratch.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          {/* Project name */}
          <div className="grid gap-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              placeholder="my-project"
              value={projectName}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={creating}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && projectName.trim() && !creating) {
                  handleCreate();
                }
              }}
            />
            {githubUsername && (
              <div className="text-text-muted flex min-w-0 items-center gap-1.5 text-xs">
                <GitHubIcon className="text-text-disabled h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  <span className="text-text-secondary font-medium">{githubUsername}</span>
                  <span className="text-text-disabled"> / </span>
                  {projectName.trim() ? (
                    <span className="text-text-secondary font-medium">{projectName.trim()}</span>
                  ) : (
                    <span className="text-text-disabled">project-name</span>
                  )}
                </span>
              </div>
            )}
          </div>

          {/* Location picker — hidden on mobile */}
          {!isMobile && (
            <div className="grid gap-2">
              <Label htmlFor="base-path">Location</Label>
              <div className="flex gap-2">
                <Input
                  id="base-path"
                  placeholder={defaultBasePath || "~/Developer"}
                  value={basePath}
                  onChange={(e) => setBasePath(e.target.value)}
                  disabled={creating}
                  className="flex-1"
                />
                {capabilities.nativeFolderPicker && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleBrowse}
                    disabled={creating}
                    title="Browse"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Template selector */}
          {PROJECT_TEMPLATES.length > 1 && (
            <div className="grid gap-2">
              <Label>Template</Label>
              <div className="grid gap-1.5">
                {PROJECT_TEMPLATES.map((tpl) => {
                  const isSelected = tpl.id === selectedTemplate.id;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => setSelectedTemplate(tpl)}
                      disabled={creating}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-100",
                        isSelected
                          ? "border-primary/40 bg-primary/5"
                          : "border-border-subtle hover:bg-bg-raised/40"
                      )}
                    >
                      <div className="bg-bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
                        {createElement(tpl.icon, {
                          className: cn(
                            "h-3.5 w-3.5",
                            isSelected ? "text-primary" : "text-text-tertiary"
                          ),
                        })}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-text-primary text-sm font-medium">{tpl.name}</p>
                        <p className="text-text-muted text-xs">{tpl.description}</p>
                      </div>
                      {isSelected && <Check className="text-primary h-4 w-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Progress / Error area */}
        <div className="min-h-[2.5rem] overflow-hidden">
          {creating && (
            <div className="bg-bg-muted/50 overflow-hidden rounded-lg px-3 py-2.5">
              {statusMessage ? (
                <p className="text-text-tertiary truncate font-mono text-xs">{statusMessage}</p>
              ) : lines.length > 0 ? (
                <div className="space-y-0.5">
                  {lines.map((line, i) => (
                    <p
                      key={i}
                      className="text-text-tertiary truncate font-mono text-xs"
                      style={{ opacity: i === lines.length - 1 ? 1 : 0.5 }}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-text-tertiary font-mono text-xs">Initializing...</p>
              )}
            </div>
          )}

          {error && !creating && (
            <div className="bg-destructive/10 flex items-start gap-2 rounded-lg px-3 py-2.5">
              <AlertCircle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={creating || !fullPath}>
            {creating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
