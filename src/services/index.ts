/**
 * Services barrel export
 * Central export for all API services
 *
 * @example
 * import { WorkspaceService, SessionService } from '@/services';
 */

export { apiClient } from '@/shared/api/client';
export { WorkspaceService } from './workspace.service';
export { SessionService } from './session.service';
export { RepoService } from './repo.service';
