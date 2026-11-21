/**
 * Sidebar feature type definitions
 * Extracted from AppSidebar.tsx for better organization
 */

import type { AddProjectAction } from "@/features/repository/lib/addProject";
import type { Workspace, DiffStats, RepoGroup } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import type { PlaceActivity, PlaceRow, WorkspaceLocation } from "../lib/location";

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
  /** Go to Home, where a workspace starts; with a project when one's "+" asked. */
  onNewWorkspace: (repoId?: string) => void;
  /** Home is what is on screen. */
  newWorkspaceActive?: boolean;
  onNewWorkspaceFromGitHub?: (repoId: string) => void;
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
  /** The cloud's way to add a project: a GitHub repository, no clone. */
  onAddFromGitHub?: () => void;
  /** The ways "Add project" offers, by the window's place. */
  addActions?: AddProjectAction[];
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
  onOpenAutomations?: () => void;
  automationsActive?: boolean;
  /** Customize: Apps, Recommended Plugins and Skills. */
  onOpenCustomize?: () => void;
  customizeActive?: boolean;
  profile?: SidebarProfile;
  /** Where this window's workspaces run; `repositories` lists only those. */
  places: SidebarPlaces;
}

/** The header's location menu: where the window can be, and where it is. */
export interface SidebarPlaces {
  /** This computer (where there is one), then each organization, or the one cloud. */
  rows: PlaceRow[];
  /** The key of the row the window is in. */
  current: string;
  /** Where the window is: this computer or the cloud. */
  location: WorkspaceLocation;
  /** Working or unread workspaces, by place key (`placeActivity`). */
  activity: Partial<Record<string, PlaceActivity>>;
  /** Choosing a row (or its ⌃ digit) does what it says. */
  onChoose: (row: PlaceRow) => void;
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
  onNewWorkspace: (repoId?: string) => void;
  onNewWorkspaceFromGitHub?: (repoId: string) => void;
  /** Where the window is (`offersNewFromBranch`). */
  windowLocation: WorkspaceLocation;
  inPlace: (workspace: Pick<Workspace, "kind" | "organization_id">) => boolean;
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
  places: SidebarPlaces;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  isExpanded: boolean;
}

/**
 * SidebarFooter component props
 */
export interface SidebarFooterProps {
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
  onAddFromGitHub?: () => void;
  /** The ways to add a project here; this computer's when not given. */
  addActions?: AddProjectAction[];
}
