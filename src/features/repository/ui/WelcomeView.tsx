import { FolderPlus, Github, Terminal } from "lucide-react";
import { Card } from "@/components/ui/card";

interface WelcomeViewProps {
  onCreateWorkspace?: () => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
}

/**
 * WelcomeView - Minimalist dashboard welcome screen
 * Design philosophy: Ruthless simplification, unified visual spine, subtle interactions
 * Clean single-purpose: introduce the app and provide quick actions
 */
export function WelcomeView({ onOpenProject, onCloneRepository }: WelcomeViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Welcome header */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="bg-foreground/5 mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
            <Terminal className="text-foreground/70 h-7 w-7" strokeWidth={1.5} />
          </div>
          <h1 className="text-foreground mb-2 text-lg font-semibold">Command</h1>
          <p className="text-muted-foreground/70 max-w-md text-sm">
            Run multiple coding tasks at once.
          </p>
          <p className="text-muted-foreground/60 mt-1 max-w-md text-xs">
            Let AI handle the details while you focus on what matters.
          </p>
        </div>

        {/* Action cards */}
        <div className="grid grid-cols-2 gap-4">
          <Card
            role="button"
            tabIndex={0}
            className="hover:bg-sidebar-accent/30 border-border/60 group flex cursor-pointer flex-col items-center gap-2.5 p-6 text-center transition-colors duration-300"
            onClick={onOpenProject}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenProject?.()}
          >
            <div className="bg-foreground/5 text-foreground/80 flex h-9 w-9 items-center justify-center rounded-lg">
              <FolderPlus className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 className="text-foreground mb-0.5 text-sm font-medium">Open Project</h3>
              <p className="text-muted-foreground/70 text-xs">Work with a local repository</p>
            </div>
          </Card>

          <Card
            role="button"
            tabIndex={0}
            className="hover:bg-sidebar-accent/30 border-border/60 group flex cursor-pointer flex-col items-center gap-2.5 p-6 text-center transition-colors duration-300"
            onClick={onCloneRepository}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onCloneRepository?.()}
          >
            <div className="bg-foreground/5 text-foreground/80 flex h-9 w-9 items-center justify-center rounded-lg">
              <Github className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 className="text-foreground mb-0.5 text-sm font-medium">Clone Repository</h3>
              <p className="text-muted-foreground/70 text-xs">Start from GitHub</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
