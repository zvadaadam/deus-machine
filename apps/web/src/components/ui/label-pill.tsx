import type { ComponentProps } from "react";
import { Badge } from "./badge";
import { cn } from "@/shared/lib/utils";

/** An outlined name, optionally rendered on its own link or button with asChild. */
export function LabelPill({
  size,
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, "variant"> & { size?: "sm" }) {
  return (
    <Badge
      data-slot="label-pill"
      variant="outline"
      className={cn(
        "border-border-default text-text-secondary [&>svg]:text-text-muted inline-flex max-w-64 min-w-0 shrink justify-start rounded-md font-normal [&>span]:truncate [&>span]:font-medium [&>svg]:shrink-0",
        "[a&]:hover:bg-control-hover [button&]:hover:bg-control-hover [a&]:hover:text-foreground [button&]:hover:text-foreground focus-visible:ring-ring transition-colors focus-visible:ring-2",
        size === "sm"
          ? "h-5 gap-1 px-1.5 text-xs [&>svg]:size-3"
          : "h-6 gap-1.5 px-2 text-sm [&>svg]:size-3.5",
        className
      )}
      {...props}
    />
  );
}
