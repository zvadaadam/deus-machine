import { cn } from "@/shared/lib/utils";

interface ResizeHandleProps {
  /** Props from useResizeHandle — onMouseDown, onDoubleClick */
  handleProps: Record<string, unknown>;
  /** Whether the handle is currently being dragged */
  isDragging: boolean;
  /** Accessible label for the separator */
  label: string;
}

/**
 * Codex-style resize handle — a zero-width separator with a gradient line
 * that fades at the top and bottom edges. Appears on hover, brightens on drag.
 *
 * Usage: pair with useResizeHandle() and spread its handleProps.
 */
export function ResizeHandle({ handleProps, isDragging, label }: ResizeHandleProps) {
  return (
    <div
      {...handleProps}
      className="group relative z-10 flex w-0 flex-shrink-0 cursor-col-resize items-center justify-center"
      aria-label={label}
      role="separator"
      aria-orientation="vertical"
    >
      {/* Hit area — wider than the visual line for easier grabbing */}
      <div className="absolute inset-y-0 w-3 -translate-x-1/2" />
      {/* Gradient separator: fades at top/bottom for a soft radiance */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2",
          "via-border bg-gradient-to-b from-transparent to-transparent",
          "transition-[colors,opacity] duration-200 ease-[ease]",
          isDragging
            ? "via-foreground/25 opacity-100"
            : "group-hover:via-foreground/25 opacity-0 group-hover:opacity-100"
        )}
      />
    </div>
  );
}
