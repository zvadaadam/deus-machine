/**
 * Grant repository access — shown when the user points a cloud workspace at a
 * private repo the Deus GitHub App doesn't cover yet. One click opens GitHub's
 * App-install page; the composer's `useCloudRepoAccess` re-checks on return and
 * continues into cloud automatically once access is granted.
 *
 * Design: DS/GrantRepositoryAccessModal (deus.pen 6x band).
 */
import { useState } from "react";
import { Github } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { installGithubApp } from "@/platform/native/deus-cloud";
import { cn } from "@/shared/lib/utils";

interface GrantRepositoryAccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `owner/name` of the repo needing access — bolded in the copy. */
  slug: string | null;
}

export function GrantRepositoryAccessModal({
  open,
  onOpenChange,
  slug,
}: GrantRepositoryAccessModalProps) {
  const [installing, setInstalling] = useState(false);

  const grant = async () => {
    setInstalling(true);
    try {
      const res = await installGithubApp();
      if (!res.ok) {
        // Web has no install IPC — point the user at the desktop app rather
        // than leaving the button silently dead.
        toast.error("Couldn't open GitHub", {
          description: res.error ?? "Grant access from the desktop app's cloud settings.",
        });
      }
      // On success the install page opens externally; the access query polls
      // while this modal is open and continues into cloud once granted.
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-6 sm:max-w-[400px]">
        <DialogTitle className="sr-only">Grant repository access</DialogTitle>

        <div className="flex flex-col items-center text-center">
          <div className="border-border/60 bg-bg-raised/50 mb-5 flex size-14 items-center justify-center rounded-2xl border">
            <Github className="text-text-primary size-7" />
          </div>

          <h2 className="text-text-primary text-lg font-medium">Grant repository access</h2>

          <p className="text-text-muted mt-2 text-sm leading-relaxed text-balance">
            Cloud agents work from a clone of{" "}
            <strong className="text-text-secondary font-medium">{slug ?? "this repository"}</strong>{" "}
            in a secure, isolated sandbox. Connect to get started.
          </p>

          <button
            type="button"
            onClick={grant}
            disabled={installing}
            className={cn(
              "mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium",
              "bg-foreground text-background transition-all duration-150",
              installing ? "cursor-default opacity-70" : "hover:opacity-90 active:scale-[0.99]"
            )}
          >
            <Github className="size-4" />
            {installing ? "Opening GitHub…" : "Grant Access"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
