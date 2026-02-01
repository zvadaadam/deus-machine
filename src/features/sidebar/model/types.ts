/**
 * Sidebar feature type definitions
 * Extracted from AppSidebar.tsx for better organization
 */

import type { Workspace, DiffStats } from "@/shared/types";

/**
 * Repository with its workspaces
 */
export interface Repository {
  repo_id: string;
  repo_name: string;
  workspaces: Workspace[];
}

/**
 * Main AppSidebar component props
 */
export interface AppSidebarProps {
  repositories: Repository[];
  selectedWorkspaceId: string | null;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string) => void;
  onAddRepository?: () => void;
  onArchive?: (workspaceId: string) => void;
  profile?: {
    username: string;
    email?: string;
  };
}

/**
 * RepositoryItem component props
 */
export interface RepositoryItemProps {
  repository: Repository;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string) => void;
  onArchive?: (workspaceId: string) => void;
  // Avoid mounting workspace list when sidebar is offcanvas-collapsed.
  sidebarExpanded: boolean;
  dragHandleProps?: {
    attributes?: Record<string, any>;
    listeners?: Record<string, any>;
    setActivatorNodeRef?: (node: HTMLElement | null) => void;
  };
}

/**
 * WorkspaceItem component props
 */
export interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  onClick: () => void;
  onArchive?: (workspaceId: string) => void;
}

/**
 * SidebarHeader component props
 */
export interface SidebarHeaderProps {
  profile?: {
    username: string;
    email?: string;
  };
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  isExpanded: boolean;
}

/**
 * SidebarFooter component props
 */
export interface SidebarFooterProps {
  onAddRepository?: () => void;
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
}
