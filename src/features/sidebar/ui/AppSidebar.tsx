import * as React from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { useUIStore } from "@/shared/stores/uiStore";
import { useSidebarStore } from "../store/sidebarStore";
import type { AppSidebarProps } from "../model/types";
import { DraggableRepository } from "./DraggableRepository";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarFooter } from "./SidebarFooter";

export function AppSidebar({
  repositories,
  selectedWorkspaceId,
  diffStats,
  onWorkspaceClick,
  onNewWorkspace,
  onAddRepository,
  onArchive,
  profile = { username: "User" },
}: AppSidebarProps) {
  const { state } = useSidebar();
  const { openSettingsModal } = useUIStore();
  const {
    collapsedRepos,
    toggleRepoCollapse,
    repositoryOrder,
    setRepositoryOrder,
    reorderRepositories,
  } = useSidebarStore();

  const isExpanded = state === "expanded";

  // Apply custom ordering - memoized to prevent unnecessary re-sorts
  const orderedRepositories = React.useMemo(
    () => reorderRepositories(repositories),
    [repositories, repositoryOrder, reorderRepositories]
  );

  // Sensors for drag detection (mouse, touch, keyboard)
  const sensors = useSensors(
    useSensor(PointerSensor),
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

    const oldIndex = orderedRepositories.findIndex(r => r.repo_id === active.id);
    const newIndex = orderedRepositories.findIndex(r => r.repo_id === over.id);

    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    // Reorder array
    const reordered = arrayMove(orderedRepositories, oldIndex, newIndex);

    // Save new order to store
    const newOrder = reordered.map(r => r.repo_id);
    setRepositoryOrder(newOrder);
  }

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader profile={profile} onOpenSettings={openSettingsModal} />

      {/* Repositories List */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-visible">
        {isExpanded ? (
          // Drag and Drop enabled when sidebar is expanded
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedRepositories.map(r => r.repo_id)}
              strategy={verticalListSortingStrategy}
            >
              <SidebarMenu className="p-2 gap-2">
                {orderedRepositories.map((repo) => (
                  <DraggableRepository
                    key={repo.repo_id}
                    repository={repo}
                    isCollapsed={collapsedRepos.has(repo.repo_id)}
                    selectedWorkspaceId={selectedWorkspaceId}
                    diffStats={diffStats}
                    onToggleCollapse={() => toggleRepoCollapse(repo.repo_id)}
                    onWorkspaceClick={onWorkspaceClick}
                    onNewWorkspace={onNewWorkspace}
                    onArchive={onArchive}
                    sidebarExpanded={isExpanded}
                  />
                ))}
              </SidebarMenu>
            </SortableContext>
          </DndContext>
        ) : (
          // No drag-drop when sidebar is collapsed (icon mode)
          <SidebarMenu className="p-2 gap-2">
            {orderedRepositories.map((repo) => (
              <DraggableRepository
                key={repo.repo_id}
                repository={repo}
                isCollapsed={collapsedRepos.has(repo.repo_id)}
                selectedWorkspaceId={selectedWorkspaceId}
                diffStats={diffStats}
                onToggleCollapse={() => toggleRepoCollapse(repo.repo_id)}
                onWorkspaceClick={onWorkspaceClick}
                onNewWorkspace={onNewWorkspace}
                onArchive={onArchive}
                sidebarExpanded={isExpanded}
                dragDisabled={true}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarContent>

      <SidebarFooter onAddRepository={onAddRepository} />
    </Sidebar>
  );
}
