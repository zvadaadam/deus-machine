/**
 * Repository-related TypeScript type definitions
 * Types for git repository management
 */

/**
 * Repository entity
 * Represents a git repository registered in Deus
 */
export interface Repository {
  id: string;
  name: string;
  root_path: string;
  git_default_branch: string;
  sort_order?: number;
  git_origin_url?: string | null;
  updated_at?: string;
}

/** What a folder holds as a git repository, read before it is added. */
export interface InspectedRepository {
  /** The repository's top-level folder, which may be above the one asked about. */
  root_path: string;
  name: string;
  git_default_branch: string;
  git_origin_url: string | null;
}

/**
 * Statistics aggregation
 * System-wide metrics for the Deus application
 */
export interface Stats {
  workspaces: number;
  workspaces_ready: number;
  workspaces_archived: number;
  repositories: number;
  sessions: number;
  sessions_idle: number;
  sessions_working: number;
  messages: number;
}
