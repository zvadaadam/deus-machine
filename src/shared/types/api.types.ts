/**
 * API-related TypeScript type definitions
 * Common types for API communication
 */

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  data: T;
  error?: string;
  message?: string;
}

/**
 * API error response
 */
export interface ApiError {
  status: number;
  message: string;
  details?: any;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Query parameters for filtering workspaces
 */
export interface WorkspaceQueryParams extends PaginationParams {
  state?: 'ready' | 'initializing' | 'archived';
  repo_id?: string;
}
