// Legacy hooks (still used for non-data-fetching concerns)
export { useAutoScroll } from './useAutoScroll';
export { useKeyboardShortcuts } from '@/shared/hooks';
export { useSocket } from '@/shared/hooks';

// TanStack Query hooks (preferred for data fetching)
export * from './queries';

// Deprecated (replaced by TanStack Query) - kept for reference
// export { useDashboardData } from './useDashboardData';
// export { useFileChanges } from './useFileChanges';
// export { useMessages } from './useMessages';
