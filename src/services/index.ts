/**
 * Services barrel export
 * Central export for all API services
 *
 * @example
 * import { SessionService } from '@/services';
 */

export { apiClient } from '@/shared/api/client';
// WorkspaceService moved to @/features/workspace/api
export { SessionService } from './session.service';
// RepoService moved to @/features/repository/api
