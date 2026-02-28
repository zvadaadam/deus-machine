import { cn } from "@/shared/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted/30 animate-pulse rounded-lg", className)}
      {...props}
    />
  );
}

export { Skeleton };
