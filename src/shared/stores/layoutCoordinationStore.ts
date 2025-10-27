/**
 * Layout Coordination Store
 *
 * Manages coordination between sidebar and browser panel states.
 * Handles auto-closing sidebar on narrow screens when browser opens,
 * and restoring sidebar state when browser closes.
 *
 * Key behaviors:
 * - Screen < 1400px: Auto-close sidebar when browser tab opens
 * - Screen >= 1400px: Keep sidebar open
 * - Track manual sidebar toggles (keyboard/click) to preserve user intent
 * - Restore previous sidebar state when browser closes (if not manually opened)
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Threshold for auto-closing sidebar (in pixels)
 * Screens narrower than this will auto-close sidebar when browser opens
 */
export const SCREEN_WIDTH_THRESHOLD = 1400;

interface LayoutCoordinationState {
  // Current browser tab state
  browserTabActive: boolean;

  // Sidebar state tracking
  sidebarWasOpenBeforeBrowser: boolean;
  userManuallyOpenedSidebar: boolean;

  // Screen dimensions
  screenWidth: number;
  isWideScreen: boolean;

  // Actions - Browser
  /**
   * Called when browser tab becomes active
   * Stores current sidebar state and triggers auto-close if on narrow screen
   */
  onBrowserTabOpen: (currentSidebarOpen: boolean) => void;

  /**
   * Called when browser tab becomes inactive (switches to changes/terminal)
   * Restores sidebar state based on user intent
   */
  onBrowserTabClose: () => { shouldRestoreSidebar: boolean };

  // Actions - Sidebar
  /**
   * Called when sidebar is toggled
   * @param isManual - true if user explicitly toggled (keyboard shortcut or click)
   */
  onSidebarToggle: (isManual: boolean, newOpenState: boolean) => void;

  // Actions - Screen
  /**
   * Updates screen width and wide screen flag
   */
  updateScreenWidth: (width: number) => void;

  // Computed helpers
  /**
   * Determines if sidebar should auto-close based on screen width
   */
  shouldAutoCloseSidebar: () => boolean;

  /**
   * Resets state (useful for testing or manual reset)
   */
  reset: () => void;
}

const initialState = {
  browserTabActive: false,
  sidebarWasOpenBeforeBrowser: false,
  userManuallyOpenedSidebar: false,
  screenWidth: typeof window !== 'undefined' ? window.innerWidth : 1920,
  isWideScreen: typeof window !== 'undefined' ? window.innerWidth >= SCREEN_WIDTH_THRESHOLD : true,
};

export const useLayoutCoordinationStore = create<LayoutCoordinationState>()(
  devtools(
    (set, get) => ({
      // Initial state
      ...initialState,

      // Actions - Browser
      onBrowserTabOpen: (currentSidebarOpen) => {
        const state = get();

        set(
          {
            browserTabActive: true,
            sidebarWasOpenBeforeBrowser: currentSidebarOpen,
            // Reset manual flag when browser opens - user intent is to use browser
            userManuallyOpenedSidebar: false,
          },
          false,
          'layout/browserTabOpen'
        );
      },

      onBrowserTabClose: () => {
        const state = get();

        set(
          {
            browserTabActive: false,
          },
          false,
          'layout/browserTabClose'
        );

        // Return whether sidebar should be restored
        // Don't restore if user manually opened it (they want it open)
        const shouldRestoreSidebar =
          !state.userManuallyOpenedSidebar &&
          state.sidebarWasOpenBeforeBrowser;

        return { shouldRestoreSidebar };
      },

      // Actions - Sidebar
      onSidebarToggle: (isManual, newOpenState) => {
        const state = get();

        // If browser is active and user manually opens sidebar, mark it
        if (state.browserTabActive && isManual && newOpenState) {
          set(
            {
              userManuallyOpenedSidebar: true,
            },
            false,
            'layout/sidebarManuallyOpened'
          );
        }

        // If sidebar was closed while browser is active, reset manual flag
        if (state.browserTabActive && !newOpenState) {
          set(
            {
              userManuallyOpenedSidebar: false,
            },
            false,
            'layout/sidebarClosed'
          );
        }
      },

      // Actions - Screen
      updateScreenWidth: (width) => {
        set(
          {
            screenWidth: width,
            isWideScreen: width >= SCREEN_WIDTH_THRESHOLD,
          },
          false,
          'layout/updateScreenWidth'
        );
      },

      // Computed helpers
      shouldAutoCloseSidebar: () => {
        const state = get();
        return !state.isWideScreen;
      },

      // Reset
      reset: () => {
        set(
          initialState,
          false,
          'layout/reset'
        );
      },
    }),
    {
      name: 'layout-coordination-store',
      enabled: process.env.NODE_ENV === 'development',
    }
  )
);
