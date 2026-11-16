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
  /**
   * The repository's folder on this computer. Null for a project that is not
   * on this computer: it has a GitHub `git_origin_url` and runs only in the cloud.
   */
  root_path: string | null;
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
