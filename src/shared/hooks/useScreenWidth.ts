import { useEffect } from 'react';
import { useLayoutCoordinationStore, SCREEN_WIDTH_THRESHOLD } from '@/shared/stores/layoutCoordinationStore';

/**
 * useScreenWidth Hook
 *
 * Tracks screen width and updates the layout coordination store.
 * Determines if screen is "wide" (>= 1400px) for auto-close behavior.
 *
 * Returns:
 * - isWideScreen: boolean - true if screen >= threshold
 * - screenWidth: number - current screen width in pixels
 *
 * @param threshold - Custom threshold in pixels (default: 1400px)
 */
export function useScreenWidth(threshold: number = SCREEN_WIDTH_THRESHOLD) {
  const { screenWidth, isWideScreen, updateScreenWidth } = useLayoutCoordinationStore();

  useEffect(() => {
    // Initialize with current width
    updateScreenWidth(window.innerWidth);

    // Update on resize (with matchMedia for better performance)
    const mql = window.matchMedia(`(min-width: ${threshold}px)`);

    const handleResize = () => {
      updateScreenWidth(window.innerWidth);
    };

    // Use both matchMedia change event and resize for comprehensive coverage
    mql.addEventListener('change', handleResize);
    window.addEventListener('resize', handleResize);

    return () => {
      mql.removeEventListener('change', handleResize);
      window.removeEventListener('resize', handleResize);
    };
  }, [threshold, updateScreenWidth]);

  return { isWideScreen, screenWidth };
}
