/**
 * Stores - Global State Management
 * Central export for all Zustand stores
 */

// Re-export workspace store for backward compatibility
export { useWorkspaceStore } from '@/features/workspace/store';

// Re-export UI store (modal state)
export { useUIStore } from '@/shared/stores/uiStore';

// Re-export sidebar store
export { useSidebarStore } from '@/features/sidebar/store';
