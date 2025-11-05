/**
 * useSidebarBrowserCoordination Hook
 *
 * Orchestrates coordination between sidebar and browser panel states.
 * Handles the complex logic of when to auto-close/restore sidebar based on:
 * - Screen width (< 1400px = auto-close)
 * - User intent (manual toggles preserve user choice)
 * - Browser tab active state
 *
 * Usage in MainLayout:
 * ```tsx
 * const { handleBrowserOpen, handleBrowserClose } = useSidebarBrowserCoordination(
 *   sidebarOpen,
 *   setSidebarOpen
 * );
 *
 * // When browser tab becomes active
 * useEffect(() => {
 *   if (activeTab === 'browser') {
 *     handleBrowserOpen();
 *   } else {
 *     handleBrowserClose();
 *   }
 * }, [activeTab]);
 * ```
 */

import { useCallback } from "react";
import { useLayoutCoordinationStore } from "@/shared/stores/layoutCoordinationStore";

interface SidebarBrowserCoordinationReturn {
  /**
   * Call when browser tab becomes active
   * Handles auto-closing sidebar on narrow screens
   */
  handleBrowserOpen: () => void;

  /**
   * Call when browser tab becomes inactive (switches away)
   * Handles restoring sidebar if appropriate
   */
  handleBrowserClose: () => void;

  /**
   * Call when sidebar is toggled by user action
   * Tracks manual toggles to preserve user intent
   */
  handleSidebarToggle: (isManual: boolean, newOpenState: boolean) => void;
}

/**
 * Hook for coordinating sidebar and browser panel behavior
 *
 * @param sidebarOpen - Current sidebar open state (from SidebarProvider or state)
 * @param setSidebarOpen - Function to update sidebar open state
 * @returns Handlers for browser and sidebar events
 */
export function useSidebarBrowserCoordination(
  sidebarOpen: boolean,
  setSidebarOpen: (open: boolean) => void
): SidebarBrowserCoordinationReturn {
  const { onBrowserTabOpen, onBrowserTabClose, onSidebarToggle, shouldAutoCloseSidebar } =
    useLayoutCoordinationStore();

  /**
   * Handler for when browser tab becomes active
   * Auto-closes sidebar on narrow screens
   */
  const handleBrowserOpen = useCallback(() => {
    // Notify store of browser opening (store current sidebar state)
    onBrowserTabOpen(sidebarOpen);

    // Auto-close sidebar if screen is narrow
    if (shouldAutoCloseSidebar() && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, onBrowserTabOpen, shouldAutoCloseSidebar, setSidebarOpen]);

  /**
   * Handler for when browser tab becomes inactive
   * Restores sidebar state if user didn't manually open it
   */
  const handleBrowserClose = useCallback(() => {
    // Notify store and get restoration decision
    const { shouldRestoreSidebar } = onBrowserTabClose();

    // Restore sidebar if appropriate
    if (shouldRestoreSidebar && !sidebarOpen) {
      setSidebarOpen(true);
    }
  }, [onBrowserTabClose, sidebarOpen, setSidebarOpen]);

  /**
   * Handler for when sidebar is toggled
   * Tracks manual vs automatic toggles
   */
  const handleSidebarToggle = useCallback(
    (isManual: boolean, newOpenState: boolean) => {
      onSidebarToggle(isManual, newOpenState);
    },
    [onSidebarToggle]
  );

  return {
    handleBrowserOpen,
    handleBrowserClose,
    handleSidebarToggle,
  };
}
