/**
 * Repository-related TypeScript type definitions
 * Types for git repository management
 */

/**
 * Repository entity
 * Represents a git repository registered in Conductor
 */
export interface Repo {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Statistics aggregation
 * System-wide metrics for the Conductor application
 */
export interface Stats {
  workspaces: number;
  workspaces_ready: number;
  workspaces_archived: number;
  repos: number;
  sessions: number;
  sessions_idle: number;
  sessions_working: number;
  sessions_compacting: number;
  messages: number;
  attachments: number;
}
