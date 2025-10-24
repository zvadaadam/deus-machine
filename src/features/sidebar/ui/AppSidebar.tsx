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

  // Debounced navigation ref for keyboard nav
  const navigationTimeoutRef = React.useRef<NodeJS.Timeout>();
  const lastNavigationRef = React.useRef<{ workspace: any; repoId: string } | null>(null);

  // Apply custom ordering - memoized to prevent unnecessary re-sorts
  const orderedRepositories = React.useMemo(
    () => reorderRepositories(repositories),
    [repositories, repositoryOrder, reorderRepositories]
  );

  // Flatten all workspaces with repo info for keyboard navigation
  const allWorkspaces = React.useMemo(() => {
    return orderedRepositories.flatMap(repo =>
      repo.workspaces.map(workspace => ({
        workspace,
        repoId: repo.repo_id
      }))
    );
  }, [orderedRepositories]);

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

      // Use last navigation target if debouncing, otherwise use actual selected
      const currentWorkspaceId = lastNavigationRef.current?.workspace.id || selectedWorkspaceId;
      let targetItem;

      // Cmd/Ctrl + Arrow: Jump between repositories
      if (e.metaKey || e.ctrlKey) {
        const currentIndex = allWorkspaces.findIndex(w => w.workspace.id === currentWorkspaceId);
        const currentRepoId = currentIndex >= 0 ? allWorkspaces[currentIndex].repoId : null;

        if (e.key === 'ArrowDown') {
          // Find first workspace of next repo
          const nextRepoIndex = currentIndex >= 0
            ? allWorkspaces.findIndex((w, i) => i > currentIndex && w.repoId !== currentRepoId)
            : 0;
          targetItem = nextRepoIndex >= 0 ? allWorkspaces[nextRepoIndex] : allWorkspaces[0];
        } else {
          // Find first workspace of previous repo
          let prevRepoIndex = -1;
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (allWorkspaces[i].repoId !== currentRepoId) {
              // Found different repo, now find its first workspace
              const targetRepoId = allWorkspaces[i].repoId;
              prevRepoIndex = allWorkspaces.findIndex(w => w.repoId === targetRepoId);
              break;
            }
          }
          targetItem = prevRepoIndex >= 0 ? allWorkspaces[prevRepoIndex] : allWorkspaces[allWorkspaces.length - 1];
        }
      } else {
        // Normal arrow: Navigate within all workspaces
        const currentIndex = allWorkspaces.findIndex(w => w.workspace.id === currentWorkspaceId);

        if (e.key === 'ArrowDown') {
          const nextIndex = currentIndex < allWorkspaces.length - 1 ? currentIndex + 1 : 0;
          targetItem = allWorkspaces[nextIndex];
        } else {
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : allWorkspaces.length - 1;
          targetItem = allWorkspaces[prevIndex];
        }
      }

      // Store this navigation for next keypress
      lastNavigationRef.current = targetItem;

      // If target workspace's repo is collapsed, expand it immediately
      if (collapsedRepos.has(targetItem.repoId)) {
        toggleRepoCollapse(targetItem.repoId);
      }

      // Scroll to it on next frame
      requestAnimationFrame(() => {
        const element = document.querySelector(`[data-workspace-id="${targetItem.workspace.id}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
      });

      // Debounce workspace selection (50ms feels instant but groups rapid presses)
      clearTimeout(navigationTimeoutRef.current);
      navigationTimeoutRef.current = setTimeout(() => {
        onWorkspaceClick(targetItem.workspace);
        lastNavigationRef.current = null; // Clear after selection completes
      }, 50);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      clearTimeout(navigationTimeoutRef.current);
    };
  }, [allWorkspaces, selectedWorkspaceId, onWorkspaceClick, collapsedRepos, toggleRepoCollapse]);

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
