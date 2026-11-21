import { cn } from "@/shared/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "bg-muted/30 animate-[fadeIn_var(--tempo-fast)_var(--tempo-ease)_var(--tempo-moderate)_backwards,var(--animate-pulse)_calc(var(--tempo-moderate)+var(--tempo-fast))] rounded-lg",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
