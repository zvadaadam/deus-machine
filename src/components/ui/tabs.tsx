"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/shared/lib/utils";

/**
 * Tab separator styling - Minimal design with colored active indicator
 *
 * Strategy:
 * 1. Vertical separators between ALL tabs
 * 2. Continuous bottom border on parent wrapper (edge-to-edge)
 * 3. Active tab gets accent-colored bottom border (2px) that overlays the base border
 * 4. This creates clear, purposeful visual hierarchy
 *
 * Benefits: Simple, clear affordance, reliable rendering, uses color meaningfully
 */
if (typeof document !== "undefined") {
  const styleId = "tabs-separator-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Active tab indicator - colored underline using accent color */
      [role="tab"][data-state="active"]::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: var(--primary);
        z-index: 10;
      }
    `;
    document.head.appendChild(style);
  }
}

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "text-muted-foreground/70 relative flex h-full items-center",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "text-muted-foreground/60 focus-visible:ring-primary/40 data-[state=inactive]:hover:text-foreground/70 data-[state=active]:text-foreground relative inline-flex items-center gap-1.5 px-6 h-full text-sm tracking-tight whitespace-nowrap transition-colors duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:font-medium data-[state=inactive]:font-normal border-r border-border/40",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
