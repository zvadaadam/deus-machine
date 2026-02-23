import { useState, useEffect, useRef } from "react";
import { AlertCircle, FolderOpen, Loader2 } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
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

interface GitCloneProgress {
  percent: number;
  received: number;
  total: number;
  received_bytes: number;
  status: string;
  phase: "connecting" | "receiving" | "indexing" | "resolving" | "complete";
}

/** User-friendly phase labels */
const PHASE_LABELS: Record<string, string> = {
  connecting: "Connecting...",
  receiving: "Downloading...",
  indexing: "Processing...",
  resolving: "Almost done...",
  complete: "Complete",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface CloneRepositoryModalProps {
  show: boolean;
  cloning: boolean;
  error: string | null;
  /** Override progress display with a custom status (e.g. "Setting up workspace...") */
  statusMessage?: string | null;
  onClose: () => void;
  onClone: (githubUrl: string, targetPath: string) => void;
  onClearError: () => void;
}

export function CloneRepositoryModal({
  show,
  cloning,
  error,
  statusMessage,
  onClose,
  onClone,
  onClearError,
}: CloneRepositoryModalProps) {
  const reduceMotion = useReducedMotion();
  const [githubUrl, setGithubUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [defaultPath, setDefaultPath] = useState("");
  const [progress, setProgress] = useState<GitCloneProgress | null>(null);
  const previousCloning = useRef(cloning);

  // Resolve default destination path on mount
  useEffect(() => {
    if (!show) return;
    (async () => {
      try {
        const { homeDir, join } = await import("@tauri-apps/api/path");
        const home = await homeDir();
        const projectsDir = await join(home, "Developer");
        setDefaultPath(projectsDir);
      } catch {
        setDefaultPath("~/Developer");
      }
    })();
  }, [show]);

  useEffect(() => {
    if (!cloning) {
      setProgress(null);
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisten = await listen<GitCloneProgress>("git-clone-progress", (event) => {
        setProgress(event.payload);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [cloning]);

  useEffect(() => {
    if (previousCloning.current && !cloning) {
      setGithubUrl("");
      setTargetPath("");
    }
    previousCloning.current = cloning;
  }, [cloning]);

  const handleClone = () => {
    if (!githubUrl.trim()) {
      return;
    }
    onClearError();
    onClone(githubUrl.trim(), targetPath.trim());
  };

  const handleUrlChange = (value: string) => {
    setGithubUrl(value);
    if (error) onClearError();
  };

  const handleClose = () => {
    setGithubUrl("");
    setTargetPath("");
    onClose();
  };

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { homeDir, join } = await import("@tauri-apps/api/path");
      const homePath = await homeDir();
      const projectsDir = await join(homePath, "Developer");

      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose destination",
        defaultPath: projectsDir,
      });

      if (typeof selected === "string") {
        setTargetPath(selected);
      }
    } catch (error) {
      console.error("Error opening folder picker:", error);
    }
  };

  const phaseLabel = progress ? PHASE_LABELS[progress.phase] || progress.status : "Connecting...";

  // Determinate progress for receiving phase, indeterminate for others
  const isIndeterminate =
    !progress || progress.phase === "connecting" || progress.phase === "resolving";
  const progressPercent = progress?.percent ?? 0;

  return (
    <Dialog open={show} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Clone Repository</DialogTitle>
          <DialogDescription className="text-text-muted text-xs">
            Clone a Git repository to your machine.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-2">
            <Label htmlFor="github-url">Repository URL</Label>
            <Input
              id="github-url"
              placeholder="https://github.com/owner/repo"
              value={githubUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              disabled={cloning}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && githubUrl.trim() && !cloning) {
                  handleClone();
                }
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="target-path">Destination</Label>
            <div className="flex gap-2">
              <Input
                id="target-path"
                placeholder={defaultPath || "~/Developer"}
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                disabled={cloning}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowse}
                disabled={cloning}
                title="Browse"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            {!targetPath && (
              <p className="text-text-muted text-xs">
                Defaults to {defaultPath || "~/Developer"}/{"{repo}"}
              </p>
            )}
          </div>
        </div>

        {/* Progress / Error area */}
        <div className="min-h-[2.5rem]">
          {cloning && (
            <div className="space-y-2.5">
              {/* Progress bar */}
              <div className="bg-muted h-1 overflow-hidden rounded-full">
                {statusMessage || isIndeterminate ? (
                  reduceMotion ? (
                    <div className="bg-primary h-full w-1/3 rounded-full" />
                  ) : (
                    <m.div
                      className="bg-primary h-full w-1/3 rounded-full"
                      animate={{ x: ["-100%", "400%"] }}
                      transition={{
                        duration: 1.5,
                        ease: [0.645, 0.045, 0.355, 1],
                        repeat: Infinity,
                      }}
                    />
                  )
                ) : (
                  <div
                    className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.max(progressPercent, 2)}%` }}
                  />
                )}
              </div>

              {/* Status text */}
              <div className="flex items-center justify-between">
                <p className="text-text-tertiary text-xs">
                  {statusMessage || phaseLabel}
                  {!statusMessage && progress && progress.received_bytes > 0 && (
                    <span className="text-text-muted ml-1.5 tabular-nums">
                      {formatBytes(progress.received_bytes)}
                    </span>
                  )}
                </p>
                {!statusMessage && progress && progressPercent > 0 && !isIndeterminate && (
                  <p className="text-text-muted text-xs tabular-nums">{progressPercent}%</p>
                )}
              </div>
            </div>
          )}

          {error && !cloning && (
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
          <Button onClick={handleClone} disabled={cloning || !githubUrl.trim()}>
            {cloning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Cloning...
              </>
            ) : (
              "Clone"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
