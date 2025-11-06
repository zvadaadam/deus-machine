import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface CloneRepositoryModalProps {
  show: boolean;
  cloning: boolean;
  onClose: () => void;
  onClone: (githubUrl: string, targetPath: string) => void;
}

/**
 * Modal for cloning a repository from GitHub
 * User enters GitHub URL and optionally a target directory
 */
export function CloneRepositoryModal({
  show,
  cloning,
  onClose,
  onClone,
}: CloneRepositoryModalProps) {
  const [githubUrl, setGithubUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const previousCloning = useRef(cloning);

  // Clear form when clone operation completes successfully
  useEffect(() => {
    if (previousCloning.current && !cloning) {
      setGithubUrl("");
      setTargetPath("");
    }
    previousCloning.current = cloning;
  }, [cloning]);

  const handleClone = () => {
    if (!githubUrl.trim()) {
      toast.error("Please enter a GitHub URL");
      return;
    }
    onClone(githubUrl.trim(), targetPath.trim());
  };

  const handleClose = () => {
    setGithubUrl("");
    setTargetPath("");
    onClose();
  };

  return (
    <Dialog open={show} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Clone Repository</DialogTitle>
          <DialogDescription>
            Clone a repository from GitHub. The repository will be added to Conductor and you can
            create workspaces from it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="github-url">GitHub URL</Label>
            <Input
              id="github-url"
              placeholder="https://github.com/user/repo.git"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              disabled={cloning}
            />
            <p className="text-muted-foreground text-sm">
              Enter the HTTPS or SSH URL of the GitHub repository
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="target-path">Target Directory (Optional)</Label>
            <Input
              id="target-path"
              placeholder="/Users/you/Projects/repo-name"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              disabled={cloning}
            />
            <p className="text-muted-foreground text-sm">Leave empty to clone into ~/Projects</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={cloning}>
            Cancel
          </Button>
          <Button onClick={handleClone} disabled={cloning || !githubUrl.trim()} className="gap-2">
            {cloning ? "⟳" : "📦"}
            {cloning ? "Cloning..." : "Clone Repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
