import { memo, useCallback } from "react";
import { Check, FolderOpen } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { RecentProject } from "../../types";

interface ProjectCardProps {
  project: RecentProject;
  selected: boolean;
  onToggle: (path: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
  claude: "Claude",
};

export const ProjectCard = memo(function ProjectCard({
  project,
  selected,
  onToggle,
}: ProjectCardProps) {
  const handleClick = useCallback(() => onToggle(project.path), [onToggle, project.path]);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={handleClick}
      className={cn(
        "control-interaction group relative flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left",
        selected
          ? "bg-onboarding-foreground/10"
          : "bg-onboarding-foreground/[0.04] hover:bg-onboarding-foreground/[0.07]"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
          selected ? "bg-onboarding-foreground/15" : "bg-onboarding-foreground/5"
        )}
      >
        {selected ? (
          <Check className="text-onboarding-foreground h-4 w-4" />
        ) : (
          <FolderOpen className="text-onboarding-foreground/40 h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-onboarding-foreground truncate text-sm font-medium">{project.name}</p>
        <p className="text-onboarding-foreground/40 truncate text-xs">{project.path}</p>
      </div>

      <span className="text-2xs bg-onboarding-foreground/5 text-onboarding-foreground/30 shrink-0 rounded-md px-2 py-0.5 font-medium tracking-wider uppercase">
        {SOURCE_LABELS[project.source] || project.source}
      </span>
    </button>
  );
});
