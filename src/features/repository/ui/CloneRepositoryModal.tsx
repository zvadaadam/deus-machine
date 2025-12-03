import { useState, useEffect, useRef } from "react";
import { FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  onClose: () => void;
  onClone: (githubUrl: string, targetPath: string) => void;
  onClearError: () => void;
}

export function CloneRepositoryModal({
  show,
  cloning,
  error,
  onClose,
  onClone,
  onClearError,
}: CloneRepositoryModalProps) {
  const [githubUrl, setGithubUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [progress, setProgress] = useState<GitCloneProgress | null>(null);
  const previousCloning = useRef(cloning);

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
      const projectsDir = await join(homePath, "Projects");

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

  return (
    <Dialog open={show} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Clone Repository</DialogTitle>
        </DialogHeader>

        <div className="grid gap-5 py-4">
          <div className="grid gap-2">
            <Label htmlFor="github-url">Repository URL</Label>
            <Input
              id="github-url"
              placeholder="https://github.com/user/repo"
              value={githubUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              disabled={cloning}
              autoFocus
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="target-path">Destination</Label>
            <div className="flex gap-2">
              <Input
                id="target-path"
                placeholder="~/Projects"
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
          </div>
        </div>

        <div className="min-h-[2.5rem]">
          {(cloning || error) && (
            <div className="border-t pt-4">
              {cloning && (
                <p className="text-muted-foreground font-mono text-sm">
                  {progress?.status || "Connecting..."}
                  {progress && progress.received_bytes > 0 && (
                    <span className="ml-2 tabular-nums">({formatBytes(progress.received_bytes)})</span>
                  )}
                </p>
              )}
              {error && !cloning && <p className="text-destructive text-sm">{error}</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={cloning}>
            Cancel
          </Button>
          <Button onClick={handleClone} disabled={cloning || !githubUrl.trim()}>
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
