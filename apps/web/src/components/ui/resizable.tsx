import * as React from "react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/shared/lib/utils";

function ResizablePanelGroup(props: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  const { className, ...rest } = props;
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
      {...rest}
    />
  );
}

// forwardRef required in React 18 — ref is a reserved prop stripped from ...props.
// Without this, imperative handles (collapse/expand/resize) silently receive null.
const ResizablePanel = React.forwardRef<
  React.ComponentRef<typeof ResizablePrimitive.Panel>,
  React.ComponentPropsWithoutRef<typeof ResizablePrimitive.Panel>
>(({ ...props }, ref) => (
  <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />
));
ResizablePanel.displayName = "ResizablePanel";

/**
 * Resize handle — zero-width separator with a gradient line
 * that fades at the top/bottom edges. Appears on hover, brightens on drag.
 * Keyboard accessible (arrow keys) via react-resizable-panels.
 *
 * Uses data-resize-handle-state (inactive | hover | drag) for CSS-only styling.
 */
function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle>) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        // Zero-width base
        "group relative z-10 flex w-0 flex-shrink-0 items-center justify-center",
        // Vertical mode: zero-height instead
        "data-[panel-group-direction=vertical]:h-0 data-[panel-group-direction=vertical]:w-full",
        // Keyboard focus ring (a11y improvement over the custom hook)
        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
        className
      )}
      {...props}
    >
      {/* Hit area — wider than the visual line for easier grabbing */}
      <div
        className={cn(
          "absolute inset-y-0 w-3 -translate-x-1/2",
          // Vertical mode: full-width hit area
          "group-data-[panel-group-direction=vertical]:inset-x-0 group-data-[panel-group-direction=vertical]:inset-y-auto group-data-[panel-group-direction=vertical]:h-3 group-data-[panel-group-direction=vertical]:w-full group-data-[panel-group-direction=vertical]:translate-x-0 group-data-[panel-group-direction=vertical]:-translate-y-1/2"
        )}
      />
      {/* Gradient separator: fades at top/bottom for a soft radiance */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2",
          "via-border bg-gradient-to-b from-transparent to-transparent",
          "transition duration-200 ease-out",
          // Drag state: visible with stronger color
          "group-data-[resize-handle-state=drag]:via-foreground/25 group-data-[resize-handle-state=drag]:opacity-100",
          // Hover state: visible with stronger color
          "group-data-[resize-handle-state=hover]:via-foreground/25 group-data-[resize-handle-state=hover]:opacity-100",
          // Inactive: hidden
          "group-data-[resize-handle-state=inactive]:opacity-0",
          // Vertical mode: horizontal gradient line
          "group-data-[panel-group-direction=vertical]:inset-x-0 group-data-[panel-group-direction=vertical]:inset-y-auto group-data-[panel-group-direction=vertical]:left-0 group-data-[panel-group-direction=vertical]:h-px group-data-[panel-group-direction=vertical]:w-full group-data-[panel-group-direction=vertical]:translate-x-0 group-data-[panel-group-direction=vertical]:-translate-y-1/2 group-data-[panel-group-direction=vertical]:bg-gradient-to-r"
        )}
      />
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
