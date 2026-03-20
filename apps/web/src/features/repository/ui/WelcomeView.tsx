import { FolderPlus, Github } from "lucide-react";
import { capabilities } from "@/platform/capabilities";

interface WelcomeViewProps {
  onCreateWorkspace?: () => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
}

/**
 * WelcomeView — Empty state when no workspace is selected.
 * Shows OpenDevs branding in pixel font + two action cards.
 */
export function WelcomeView({ onOpenProject, onCloneRepository }: WelcomeViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Branding */}
        <div className="mb-10 flex flex-col items-center text-center">
          <h1 className="text-text-primary mb-3 text-3xl font-extrabold tracking-tight">
            OpenDevs
          </h1>
          <p className="text-text-tertiary max-w-xs text-sm">
            Manage multiple AI coding agents in parallel.
          </p>
          <p className="text-text-muted mt-1 max-w-xs text-xs">
            Ship faster with your dev team of AIs.
          </p>
        </div>

        {/* Action cards */}
        <div
          className={`grid gap-4 ${capabilities.nativeFolderPicker ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {capabilities.nativeFolderPicker && (
            <button
              type="button"
              onClick={onOpenProject}
              className="bg-bg-elevated hover:bg-bg-raised flex cursor-pointer flex-col items-center gap-3 rounded-xl p-6 text-center transition-colors duration-200"
            >
              <div className="bg-bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
                <FolderPlus className="text-text-tertiary h-4 w-4" />
              </div>
              <div>
                <h3 className="text-text-primary mb-0.5 text-sm font-medium">Open local project</h3>
                <p className="text-text-muted text-xs">Add an existing repository</p>
              </div>
            </button>
          )}

          <button
            type="button"
            onClick={onCloneRepository}
            className="bg-bg-elevated hover:bg-bg-raised flex cursor-pointer flex-col items-center gap-3 rounded-xl p-6 text-center transition-colors duration-200"
          >
            <div className="bg-bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <Github className="text-text-tertiary h-4 w-4" />
            </div>
            <div>
              <h3 className="text-text-primary mb-0.5 text-sm font-medium">Clone from GitHub</h3>
              <p className="text-text-muted text-xs">Start from a remote repository</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
