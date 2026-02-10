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
 * Hover: bg-surface (subtle, not aggressive)
 * Padding: repo=8px, workspace=10px 12px 10px 20px
 */
const rowVariants: Record<SidebarRowVariant, string> = {
  repo: "py-2 px-3",
  workspace: "py-2.5 px-3 pl-5",
  action: "py-2.5 px-3 pl-5",
};

export function SidebarRow({
  variant = "repo",
  isActive = false,
  asChild = false,
  className,
  ...props
}: SidebarRowProps) {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      className={cn(
        "group/sidebar-row relative flex w-full items-center justify-between gap-3 rounded-md",
        "transition-colors duration-100 ease-out",
        rowVariants[variant],
        isActive ? "bg-bg-selection" : "hover:bg-bg-surface",
        className
      )}
      {...props}
    />
  );
}

interface SidebarRowMainProps extends React.ComponentProps<"div"> {
  asChild?: boolean;
  indent?: "none" | "workspace";
}

export function SidebarRowMain({
  asChild = false,
  indent = "none",
  className,
  ...props
}: SidebarRowMainProps) {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        indent === "workspace" && "pl-0",
        className
      )}
      {...props}
    />
  );
}

export function SidebarRowIconSlot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

export function SidebarRowRight({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}
