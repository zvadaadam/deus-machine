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

  // Flatten all workspaces for keyboard navigation
  const allWorkspaces = React.useMemo(() => {
    return orderedRepositories.flatMap(repo => repo.workspaces);
  }, [orderedRepositories]);

  // Auto-scroll to selected workspace
  React.useEffect(() => {
    if (!selectedWorkspaceId) return;

    // Small delay to ensure DOM is updated
    const timer = setTimeout(() => {
      const element = document.querySelector(`[data-workspace-id="${selectedWorkspaceId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [selectedWorkspaceId]);

  // Keyboard navigation for workspaces (Up/Down arrows)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if no input/textarea is focused
      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement?.tagName === 'INPUT' ||
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.getAttribute('contenteditable') === 'true';

      if (isInputFocused) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!allWorkspaces.length) return;

      e.preventDefault();
      e.stopPropagation();

      // Remove focus rings
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      const currentIndex = allWorkspaces.findIndex(w => w.id === selectedWorkspaceId);

      if (e.key === 'ArrowDown') {
        const nextIndex = currentIndex < allWorkspaces.length - 1 ? currentIndex + 1 : 0;
        onWorkspaceClick(allWorkspaces[nextIndex]); // Pass full workspace object
      } else if (e.key === 'ArrowUp') {
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : allWorkspaces.length - 1;
        onWorkspaceClick(allWorkspaces[prevIndex]); // Pass full workspace object
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [allWorkspaces, selectedWorkspaceId, onWorkspaceClick]);

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
