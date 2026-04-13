import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";
import { useSession } from "@/features/session/context";
import {
  workspaceLayoutActions,
  type FileNavigationTarget,
} from "@/features/workspace/store/workspaceLayoutStore";
import { cn } from "@/shared/lib/utils";

interface ToolFileLinkProps {
  path: string;
  target: FileNavigationTarget;
  className?: string;
}

function normalizeToolFilePath(path: string, workspacePath: string | null): string | null {
  const normalizedPath = path.replace(/\\/g, "/").trim();
  const normalizedWorkspacePath = workspacePath?.replace(/\\/g, "/").replace(/\/$/, "") ?? null;
  const isAbsolutePath = /^(?:[A-Za-z]:\/|\/)/.test(normalizedPath);

  if (!normalizedPath) return null;

  if (normalizedWorkspacePath) {
    if (normalizedPath.startsWith(`${normalizedWorkspacePath}/`)) {
      const relativePath = normalizedPath
        .slice(normalizedWorkspacePath.length + 1)
        .replace(/^\/+/, "");
      return relativePath || null;
    }

    if (isAbsolutePath) {
      return null;
    }
  }

  if (isAbsolutePath) {
    return null;
  }

  const relativePath = normalizedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return relativePath || null;
}

export function ToolFileLink({ path, target, className }: ToolFileLinkProps) {
  const { workspaceId, workspacePath } = useSession();

  const normalizedPath = useMemo(
    () => normalizeToolFilePath(path, workspacePath),
    [path, workspacePath]
  );

  if (!workspaceId || !normalizedPath) {
    return null;
  }

  const targetLabel = target === "files" ? "Files" : "Changes";

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        workspaceLayoutActions.openFileInContent(workspaceId, normalizedPath, target);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
      className={cn(
        "group/file-link inline-flex max-w-full min-w-0 items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 font-mono text-sm font-normal",
        "border-primary/10 bg-accent-blue-surface text-primary/85 border transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out",
        "hover:border-primary/25 hover:bg-primary/12 hover:text-primary hover:shadow-xs",
        "focus-visible:ring-ring/60 focus-visible:ring-2 focus-visible:outline-none",
        className
      )}
      title={`Open in ${targetLabel}`}
      aria-label={`${normalizedPath} — open in ${targetLabel}`}
    >
      <span className="block min-w-0 truncate" dir="rtl">
        {normalizedPath}
      </span>
      <ArrowUpRight className="text-primary/45 group-hover/file-link:text-primary/70 group-focus-visible/file-link:text-primary/70 h-3.5 w-3.5 flex-shrink-0 opacity-90 transition-[color,transform,opacity] duration-150 ease-out group-hover/file-link:translate-x-px group-hover/file-link:opacity-100 group-focus-visible/file-link:translate-x-px group-focus-visible/file-link:opacity-100" />
    </button>
  );
}
