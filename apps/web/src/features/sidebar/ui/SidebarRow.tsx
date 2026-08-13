import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/shared/lib/utils";

type SidebarRowVariant = "repo" | "workspace" | "action";

interface SidebarRowProps extends React.ComponentProps<"div"> {
  variant?: SidebarRowVariant;
  isActive?: boolean;
  asChild?: boolean;
}

/**
 * SidebarRow — V2: Jony Ive
 *
 * Active: bg-selection (warm white in light, elevated in dark)
 * Hover: 4% foreground overlay (barely visible, theme-agnostic)
 * Padding: repo=8px 12px, workspace/action=6px 12px (single-line rows, ~32px)
 * Workspace items use same left padding as repo — alignment comes from 20x20 icon wrappers.
 */
const rowVariants: Record<SidebarRowVariant, string> = {
  repo: "py-2 px-3",
  workspace: "py-1.5 px-3",
  action: "py-1.5 px-3",
};

export const SidebarRow = React.forwardRef<HTMLDivElement, SidebarRowProps>(function SidebarRow(
  { variant = "repo", isActive = false, asChild = false, className, ...props },
  ref
) {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      ref={ref}
      className={cn(
        "group/sidebar-row relative flex w-full items-center justify-between gap-3 rounded-lg",
        "transition-colors duration-100 ease-out",
        rowVariants[variant],
        isActive ? "bg-bg-selection" : "hover:bg-foreground/[0.04]",
        className
      )}
      {...props}
    />
  );
});

interface SidebarRowMainProps extends React.ComponentProps<"div"> {
  asChild?: boolean;
}

export function SidebarRowMain({ asChild = false, className, ...props }: SidebarRowMainProps) {
  const Comp = asChild ? Slot : "div";

  return <Comp className={cn("flex min-w-0 flex-1 items-center gap-2", className)} {...props} />;
}

/** Flush-left icon slot — aligns glyphs with the repo label above. */
export function SidebarRowIconSlot({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("flex h-5 w-3.5 shrink-0 items-center", className)} {...props} />;
}

export function SidebarRowRight({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}
