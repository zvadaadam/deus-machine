import { useState, useEffect, useCallback } from "react";
import { AlertCircle, FolderOpen, Loader2 } from "lucide-react";
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
import { native, capabilities } from "@/platform";
import { useIsMobile } from "@/shared/hooks/use-mobile";

const MAX_LINES = 3;

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
  const isMobile = useIsMobile();
  const [githubUrl, setGithubUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [defaultPath, setDefaultPath] = useState("");
  const [lines, setLines] = useState<string[]>([]);

  // Resolve default destination path on mount.
  useEffect(() => {
    if (!show) return;
    (async () => {
      try {
        const home = await native.dialog.getHomeDir();
        setDefaultPath(isMobile ? `${home}/.deus/repos` : `${home}/Developer`);
      } catch {
        setDefaultPath(isMobile ? "~/.deus/repos" : "~/Developer");
      }
      if (isMobile) setTargetPath("");
    })();
  }, [show, isMobile]);

  // Listen for raw git stderr lines while cloning
  useEffect(() => {
    if (!cloning) return;

    const unlisten = onEvent((event, data) => {
      if (event === "git-clone-progress") {
        const { line } = data as { line: string };
        if (line) {
          setLines((prev) => [...prev, line].slice(-MAX_LINES));
        }
      }
    });

    return unlisten;
  }, [cloning]);

  const handleClone = useCallback(() => {
    if (!githubUrl.trim()) return;
    onClearError();
    setLines([]);
    const effectivePath = isMobile ? defaultPath : targetPath.trim();
    onClone(githubUrl.trim(), effectivePath);
  }, [githubUrl, isMobile, defaultPath, targetPath, onClearError, onClone]);

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
      const selected = await native.dialog.pickFolder();
      if (typeof selected === "string") {
        setTargetPath(selected);
      }
    } catch (err) {
      console.error("Error opening folder picker:", err);
    }
  };

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

          {/* Destination picker -- hidden on mobile */}
          {!isMobile && (
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
                {capabilities.nativeFolderPicker && (
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
                )}
              </div>
              {!targetPath && (
                <p className="text-text-muted text-xs">
                  Defaults to {defaultPath || "~/Developer"}/{"{repo}"}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Progress / Error area */}
        <div className="min-h-[2.5rem]">
          {cloning && (
            <div className="bg-bg-muted/50 rounded-lg px-3 py-2.5">
              {statusMessage ? (
                <p className="text-text-tertiary font-mono text-xs">{statusMessage}</p>
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
                <p className="text-text-tertiary font-mono text-xs">Connecting...</p>
              )}
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
