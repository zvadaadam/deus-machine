import type { ProjectAgent } from "@shared/projects";
import type { DiffStats, Workspace } from "@/shared/types";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { ConnectionBanner } from "@/features/connection";
import { cn } from "@/shared/lib/utils";
import { ProjectDetailView } from "./ProjectDetailView";

export function ProjectsPage({
  projectId,
  workspaces,
  diffStats,
  onOpenWorkspace,
}: {
  projectId: string;
  workspaces: Workspace[];
  diffStats?: Record<string, DiffStats>;
  onOpenWorkspace: (agent: ProjectAgent) => void;
}) {
  const { open, isMobile } = useSidebar();
  return (
    <SidebarInset className="min-w-0">
      <ConnectionBanner />
      <div
        className={cn(
          "bg-bg-surface flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          isMobile
            ? "border-0"
            : open
              ? "border-border-subtle rounded-tl-xl border border-r-0"
              : "border border-transparent"
        )}
        data-slot="projects-page"
      >
        <ProjectDetailView
          key={projectId}
          projectId={projectId}
          workspaces={workspaces}
          diffStats={diffStats}
          onOpenWorkspace={onOpenWorkspace}
        />
      </div>
    </SidebarInset>
  );
}
