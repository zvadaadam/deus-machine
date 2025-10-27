/**
 * Turn Divider Component
 *
 * Visual separator between tool executions and summary text.
 * Creates clear hierarchy: Actions → Summary
 *
 * Design Specs:
 * - Height: 1px
 * - Color: --border/40 (subtle)
 * - Margin: 16px vertical (my-4)
 */

import { cn } from '@/shared/lib/utils';

export function TurnDivider() {
  return (
    <div
      className={cn(
        'w-full h-px bg-border/40 my-4',
        'motion-reduce:my-2' // Reduce spacing for reduced motion
      )}
      aria-hidden="true"
    />
  );
}
