import * as React from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { FolderOpen } from "lucide-react";
import { Sidebar, SidebarContent, SidebarMenu, useSidebar } from "@/components/ui/sidebar";
import { useUIStore } from "@/shared/stores/uiStore";
import { useSidebarStore } from "../store/sidebarStore";
import type { AppSidebarProps } from "../model/types";
import { DraggableRepository } from "./DraggableRepository";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarFooter } from "./SidebarFooter";

export function AppSidebar({
  repositories,
  selectedWorkspaceId,
  onWorkspaceClick,
  onNewWorkspace,
  onNewWorkspaceFromGitHub,
  onAddRepository,
  onCloneRepository,
  onArchive,
  onStatusChange,
  onNewSession,
  diffStatsMap,
  profile = { username: "User" },
}: AppSidebarProps) {
  const { state, hoverOpen, toggleSidebar } = useSidebar();
  const openSettings = useUIStore((s) => s.openSettings);
  const collapsedRepos = useSidebarStore((s) => s.collapsedRepos);
  const toggleRepoCollapse = useSidebarStore((s) => s.toggleRepoCollapse);
  const repositoryOrder = useSidebarStore((s) => s.repositoryOrder);
  const setRepositoryOrder = useSidebarStore((s) => s.setRepositoryOrder);
  const reorderRepositories = useSidebarStore((s) => s.reorderRepositories);

  const isExpanded = state === "expanded" || hoverOpen;

  // User's drag-drop order is the final word.
  // Status is shown visually (badges, colors) — not by re-sorting after drag.
  const orderedRepositories = React.useMemo(
    () => reorderRepositories(repositories),
    [repositories, repositoryOrder, reorderRepositories]
  );

  // Mouse: 5px distance differentiates click from drag
  // Touch: 250ms long-press required before drag activates (allows normal scrolling)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  /**
   * Handle drag end - reorder repositories
   */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = orderedRepositories.findIndex((r) => r.repo_id === active.id);
    const newIndex = orderedRepositories.findIndex((r) => r.repo_id === over.id);

    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    // Reorder array
    const reordered = arrayMove(orderedRepositories, oldIndex, newIndex);

    // Save new order to store
    const newOrder = reordered.map((r) => r.repo_id);
    setRepositoryOrder(newOrder);
  }

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="p-0">
      <SidebarHeader
        profile={profile}
        onOpenSettings={openSettings}
        onToggleSidebar={toggleSidebar}
        onNewSession={onNewSession}
        isExpanded={isExpanded}
      />

      {/* Repositories List or Empty State */}
      {repositories.length === 0 ? (
        <SidebarContent className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <FolderOpen className="text-text-muted/30 h-10 w-10" strokeWidth={1.5} />
            <div className="space-y-1">
              <p className="text-text-secondary text-sm font-medium">No projects yet</p>
              <p className="text-text-muted text-xs">Add your first project to get started</p>
            </div>
          </div>
        </SidebarContent>
      ) : (
        <SidebarContent className="scrollbar-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedRepositories.map((r) => r.repo_id)}
              strategy={verticalListSortingStrategy}
            >
              <SidebarMenu className="gap-1 px-1.5 py-2">
                {orderedRepositories.map((repo) => (
                  <DraggableRepository
                    key={repo.repo_id}
                    repository={repo}
                    isCollapsed={collapsedRepos.has(repo.repo_id)}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onToggleCollapse={() => toggleRepoCollapse(repo.repo_id)}
                    onWorkspaceClick={onWorkspaceClick}
                    onNewWorkspace={onNewWorkspace}
                    onNewWorkspaceFromGitHub={onNewWorkspaceFromGitHub}
                    onArchive={onArchive}
                    onStatusChange={onStatusChange}
                    diffStatsMap={diffStatsMap}
                    sidebarExpanded={isExpanded}
                    dragDisabled={!isExpanded}
                  />
                ))}
              </SidebarMenu>
            </SortableContext>
          </DndContext>
        </SidebarContent>
      )}

      <SidebarFooter onAddRepository={onAddRepository} onCloneRepository={onCloneRepository} />
    </Sidebar>
  );
}
