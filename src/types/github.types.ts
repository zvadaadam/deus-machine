/**
 * GitHub-related TypeScript type definitions
 * Types for GitHub PR and repository operations
 */

/**
 * Pull Request status information
 * Metadata about a PR associated with a workspace
 */
export interface PRStatus {
  has_pr: boolean;
  pr_number?: number;
  pr_title?: string;
  pr_url?: string;
  merge_status?: 'ready' | 'pending' | 'blocked' | 'merged';
}

/**
 * Development server information
 * Local dev servers detected in workspace
 */
export interface DevServer {
  port: number;
  url: string;
  type: 'vite' | 'webpack' | 'angular' | 'node' | 'other';
  name: string;
}
