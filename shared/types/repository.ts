/**
 * Repository-related TypeScript type definitions
 * Types for git repository management
 */

/**
 * Repository entity
 * Represents a git repository registered in Hive
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

/**
 * Statistics aggregation
 * System-wide metrics for the Hive application
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
