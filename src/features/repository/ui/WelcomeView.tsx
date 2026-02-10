import { FolderPlus, Github, Terminal } from "lucide-react";

interface WelcomeViewProps {
  onCreateWorkspace?: () => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
}

/**
 * WelcomeView — V2: Jony Ive
 *
 * "Simplicity is not the absence of clutter. It's the sense
 *  that everything is exactly where it should be."
 *
 * Minimal center-stage layout. Two quiet action cards.
 * No borders on cards — depth through background tier only.
 */
export function WelcomeView({ onOpenProject, onCloneRepository }: WelcomeViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Welcome header */}
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="bg-bg-elevated mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
            <Terminal className="text-text-tertiary h-7 w-7" strokeWidth={1.5} />
          </div>
          <h1 className="text-text-primary mb-2 text-lg font-semibold">Command</h1>
          <p className="text-text-tertiary max-w-md text-sm">Run multiple coding tasks at once.</p>
          <p className="text-text-muted mt-1 max-w-md text-xs">
            Let AI handle the details while you focus on what matters.
          </p>
        </div>

        {/* Action cards — no borders, depth via bg tier */}
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={onOpenProject}
            className="bg-bg-elevated hover:bg-bg-raised flex cursor-pointer flex-col items-center gap-3 rounded-xl p-6 text-center transition-colors duration-200"
          >
            <div className="bg-bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <FolderPlus className="text-text-tertiary h-4 w-4" />
            </div>
            <div>
              <h3 className="text-text-primary mb-0.5 text-sm font-medium">Open Project</h3>
              <p className="text-text-muted text-xs">Work with a local repository</p>
            </div>
          </button>

          <button
            type="button"
            onClick={onCloneRepository}
            className="bg-bg-elevated hover:bg-bg-raised flex cursor-pointer flex-col items-center gap-3 rounded-xl p-6 text-center transition-colors duration-200"
          >
            <div className="bg-bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <Github className="text-text-tertiary h-4 w-4" />
            </div>
            <div>
              <h3 className="text-text-primary mb-0.5 text-sm font-medium">Clone Repository</h3>
              <p className="text-text-muted text-xs">Start from GitHub</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
