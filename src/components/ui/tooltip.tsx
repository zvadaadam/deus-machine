"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/shared/lib/utils";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentProps<typeof TooltipPrimitive.Trigger>
>(({ ...props }, ref) => {
  return <TooltipPrimitive.Trigger ref={ref} data-slot="tooltip-trigger" {...props} />;
});

TooltipTrigger.displayName = "TooltipTrigger";

function TooltipContent({
  className,
  sideOffset = 4,
  showArrow = false,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { showArrow?: boolean }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Surface
          "bg-popover text-popover-foreground border-border border shadow-md",
          // Layout + origin-aware scaling (Radix provides transform origin)
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-2.5 py-1 text-xs text-balance will-change-transform",
          // Enter: 200ms with Emil Kowalski's custom ease-out curve
          "data-[state=delayed-open]:animate-[tooltip-enter_200ms_cubic-bezier(.215,.61,.355,1)]",
          "data-[state=instant-open]:animate-[tooltip-enter_150ms_cubic-bezier(.215,.61,.355,1)]",
          // Exit: faster, same ease-out (ease-out for both enter & exit per Kowalski)
          "data-[state=closed]:animate-[tooltip-exit_150ms_cubic-bezier(.215,.61,.355,1)]",
          // Directional offsets (3px nudge toward trigger)
          "data-[side=top]:[--tooltip-translate-y:3px]",
          "data-[side=bottom]:[--tooltip-translate-y:-3px]",
          "data-[side=left]:[--tooltip-translate-x:3px]",
          "data-[side=right]:[--tooltip-translate-x:-3px]",
          className
        )}
        {...props}
      >
        {children}
        {showArrow && (
          <TooltipPrimitive.Arrow className="bg-popover fill-popover z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/**
 * TooltipKbd — keyboard shortcut badge for use inside TooltipContent.
 * Matches the reference style: translucent bg, small rounded pill.
 *
 * Usage:
 *   <TooltipContent>
 *     <div className="flex items-center gap-3">
 *       <span>Toggle terminal</span>
 *       <TooltipKbd>⌘J</TooltipKbd>
 *     </div>
 *   </TooltipContent>
 */
function TooltipKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[11px] leading-none font-medium tracking-wide">
      {children}
    </kbd>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipKbd };
