/**
 * Repository-related TypeScript type definitions
 * Types for git repository management
 */

/**
 * Repository entity
 * Represents a git repository registered in Hive
 */
export interface Repo {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  display_order?: number;
  github_url?: string | null;
  created_at?: string;
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
  repos: number;
  sessions: number;
  sessions_idle: number;
  sessions_working: number;
  messages: number;
}
