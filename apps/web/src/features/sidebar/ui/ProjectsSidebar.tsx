import { useId } from "react";
import { ChevronRight, FolderKanban, Plus } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useProjects } from "@/features/projects/api/projects.queries";
import { getProjectStatusPresentation } from "@/features/projects/ui/ProjectStatus";
import { CircularPixelGrid } from "@/features/session/ui/CircularPixelGrid";
import { useUIStore } from "@/shared/stores/uiStore";
import { cn } from "@/shared/lib/utils";
import { useSidebarStore } from "../store/sidebarStore";
import { SidebarRow, SidebarRowMain } from "./SidebarRow";

interface ProjectsSidebarProps {
  isActive?: boolean;
  sidebarExpanded: boolean;
  onOpen: (projectId: string) => void;
  onCreate: () => void;
}

export function ProjectsSidebar({
  isActive,
  sidebarExpanded,
  onOpen,
  onCreate,
}: ProjectsSidebarProps) {
  const query = useProjects();
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const collapsed = useSidebarStore((state) => state.projectsCollapsed);
  const toggleCollapsed = useSidebarStore((state) => state.toggleProjectsCollapse);
  const reduceMotion = useReducedMotion();
  const listId = useId();
  // Activity updates change the status in place rather than moving rows under the pointer.
  const projects = (query.data ?? [])
    .filter((project) => project.status !== "archived")
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

  return (
    <section aria-label="Projects">
      <SidebarRow variant="action" className="gap-1 py-0 pr-1">
        <SidebarRowMain asChild>
          <button
            type="button"
            className="min-h-8 py-1.5 text-left"
            aria-label={collapsed ? "Expand Projects" : "Collapse Projects"}
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={toggleCollapsed}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <FolderKanban className="text-text-muted size-3.5" />
            </span>
            <span className="text-text-secondary truncate text-sm">Projects</span>
            {projects.length > 0 && (
              <span className="text-text-disabled text-xs tabular-nums">{projects.length}</span>
            )}
            <ChevronRight
              aria-hidden
              className={cn(
                "text-text-muted size-3.5 transition-transform duration-150",
                !collapsed && "rotate-90"
              )}
            />
          </button>
        </SidebarRowMain>
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={onCreate}
          className="control-interaction text-text-muted hover:text-text-secondary flex size-7 shrink-0 items-center justify-center rounded-lg"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </SidebarRow>
      <AnimatePresence initial={false}>
        {!collapsed && sidebarExpanded && (
          <m.ul
            id={listId}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.165, 0.84, 0.44, 1] }}
            className="flex min-w-0 flex-col overflow-hidden pt-1 pb-2"
          >
            {projects.map((project) => {
              const active = !!isActive && selectedProjectId === project.id;
              const { label, compactLabel, Icon, className } = getProjectStatusPresentation(
                project.status
              );
              const working = project.status === "working" || project.status === "preparing";
              return (
                <li key={project.id}>
                  <SidebarRow variant="workspace" isActive={active} asChild>
                    <button
                      type="button"
                      data-project-id={project.id}
                      aria-label={`Project ${project.title}, ${label}`}
                      aria-current={active ? "page" : undefined}
                      title={`${project.title} · ${label}`}
                      onClick={() => onOpen(project.id)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span aria-hidden className="flex h-5 w-3.5 shrink-0 items-center">
                          {working ? (
                            <CircularPixelGrid variant="working" size={14} resolution={8} />
                          ) : (
                            <Icon className={cn("size-3.5", className)} />
                          )}
                        </span>
                        <span
                          className={cn(
                            "truncate text-base",
                            active
                              ? "text-text-primary font-medium"
                              : working || project.status === "needs-attention"
                                ? "text-text-primary"
                                : "text-text-tertiary"
                          )}
                        >
                          {project.title}
                        </span>
                      </span>
                      <span className={cn("shrink-0 text-xs", className)}>{compactLabel}</span>
                    </button>
                  </SidebarRow>
                </li>
              );
            })}
            {projects.length === 0 && (
              <li className="text-text-muted px-3 py-1.5 text-xs">
                {query.isPending
                  ? "Loading projects…"
                  : query.isError
                    ? "Projects unavailable"
                    : "No projects yet"}
              </li>
            )}
          </m.ul>
        )}
      </AnimatePresence>
    </section>
  );
}
