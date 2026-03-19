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
      onClick={handleClick}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors duration-200",
        selected ? "bg-white/10" : "bg-white/[0.04] hover:bg-white/[0.07]"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
          selected ? "bg-white/15" : "bg-white/5"
        )}
      >
        {selected ? (
          <Check className="h-4 w-4 text-white" />
        ) : (
          <FolderOpen className="h-4 w-4 text-white/40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{project.name}</p>
        <p className="truncate text-xs text-white/40">{project.path}</p>
      </div>

      <span className="text-2xs shrink-0 rounded-md bg-white/5 px-2 py-0.5 font-medium tracking-wider text-white/30 uppercase">
        {SOURCE_LABELS[project.source] || project.source}
      </span>
    </button>
  );
});
