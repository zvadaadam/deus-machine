import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/shared/lib/utils";

type SidebarRowVariant = "repo" | "workspace" | "action";

interface SidebarRowProps extends React.ComponentProps<"div"> {
  variant?: SidebarRowVariant;
  isActive?: boolean;
  asChild?: boolean;
}

const rowVariants: Record<SidebarRowVariant, string> = {
  repo: "py-2",
  workspace: "py-2",
  action: "py-2",
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
        "px-1 transition-all duration-[80ms] ease-out",
        rowVariants[variant],
        isActive ? "bg-foreground/5" : "hover:bg-foreground/5",
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
        indent === "workspace" && "pl-3",
        className
      )}
      {...props}
    />
  );
}

export function SidebarRowIconSlot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("flex h-4 w-4 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

export function SidebarRowRight({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}
