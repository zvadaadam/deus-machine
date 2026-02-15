import { PenTool, ExternalLink, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkspaceService } from "@/features/workspace/api/workspace.service";
import { queryKeys } from "@/shared/api/queryKeys";

interface DesignPanelProps {
  workspaceId: string;
}

/** Split a file path into directory prefix and filename */
function splitPath(filePath: string) {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", name: filePath };
  return { dir: filePath.slice(0, lastSlash + 1), name: filePath.slice(lastSlash + 1) };
}

export function DesignPanel({ workspaceId }: DesignPanelProps) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.workspaces.penFiles(workspaceId),
    queryFn: () => WorkspaceService.fetchPenFiles(workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const penFiles = data?.files ?? [];
  const hasPenFiles = !isLoading && penFiles.length > 0;
  const isEmpty = !isLoading && penFiles.length === 0;

  function handleOpenFile(filePath: string) {
    WorkspaceService.openPenFile(workspaceId, filePath).catch((err) => {
      console.error("[DesignPanel] Failed to open file:", err);
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border/40 flex h-9 items-center gap-2 border-b px-4">
        <PenTool className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Design Canvas</span>
        {hasPenFiles && (
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {penFiles.length} {penFiles.length === 1 ? "file" : "files"}
          </span>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          <p className="text-muted-foreground text-xs">Scanning for design files...</p>
        </div>
      )}

      {/* File list */}
      {hasPenFiles && (
        <ScrollArea className="flex-1">
          <div className="py-2">
            {penFiles.map((file) => {
              const { dir, name } = splitPath(file.path);
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => handleOpenFile(file.path)}
                  className="hover:bg-muted/50 w-full px-4 py-2.5 text-left text-sm transition-colors duration-200 ease-out"
                >
                  <span className="text-muted-foreground">{dir}</span>
                  <span className="text-foreground font-semibold">{name}</span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* Empty state — promote pencil.dev */}
      {isEmpty && (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
          style={{ animation: "fadeInUp 0.4s cubic-bezier(.215, .61, .355, 1)" }}
        >
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <PenTool className="text-muted-foreground/50 h-5 w-5" />
          </div>
          <div className="space-y-1.5">
            <p className="text-foreground text-sm font-medium">No design files found</p>
            <p className="text-muted-foreground max-w-[240px] text-xs leading-relaxed">
              Add{" "}
              <code className="bg-muted/60 rounded px-1 py-0.5 font-mono text-[11px]">.pen</code>{" "}
              files to your project to design alongside your code.
            </p>
          </div>
          <a
            href="https://pencil.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-foreground text-background hover:bg-foreground/90 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition-colors duration-200 ease-out"
          >
            Get started with Pencil
            <ExternalLink className="h-3 w-3" />
          </a>
          <p className="text-muted-foreground/70 text-[11px]">Claude Code for Design</p>
        </div>
      )}
    </div>
  );
}
