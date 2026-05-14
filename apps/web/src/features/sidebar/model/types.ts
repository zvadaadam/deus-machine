/**
 * Sidebar feature type definitions
 * Extracted from AppSidebar.tsx for better organization
 */

import type { Workspace, DiffStats, RepoGroup } from "@/shared/types";
import type { WorkspaceKind, WorkspaceStatus } from "@shared/enums";

/**
 * Sidebar profile chip — derived from `gh api user` via useGhStatus().
 * `login` is the GitHub username; falsy when unauthenticated.
 */
export interface SidebarProfile {
  login?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/**
 * Main AppSidebar component props
 */
export interface AppSidebarProps {
  repositories: RepoGroup[];
  selectedWorkspaceId: string | null;
  diffStatsMap?: Record<string, DiffStats>;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string, kind?: WorkspaceKind) => void;
  onNewWorkspaceFromGitHub?: (repoId: string) => void;
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
  onNewSession?: () => void;
  profile?: SidebarProfile;
}

/**
 * RepositoryItem component props
 */
export interface RepositoryItemProps {
  repository: RepoGroup;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  diffStatsMap?: Record<string, DiffStats>;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string, kind?: WorkspaceKind) => void;
  onNewWorkspaceFromGitHub?: (repoId: string) => void;
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
  // Avoid mounting workspace list when sidebar is offcanvas-collapsed.
  sidebarExpanded: boolean;
}

/**
 * WorkspaceItem component props
 */
export interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  diffStats?: DiffStats;
  onClick: (workspace: Workspace) => void;
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
}

/**
 * SidebarHeader component props
 */
export interface SidebarHeaderProps {
  profile?: SidebarProfile;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  onNewSession?: () => void;
  isExpanded: boolean;
}

/**
 * SidebarFooter component props
 */
export interface SidebarFooterProps {
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
}
