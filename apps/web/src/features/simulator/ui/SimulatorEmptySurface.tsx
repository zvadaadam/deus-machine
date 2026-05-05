import { cn } from "@/shared/lib/utils";

interface SimulatorEmptySurfaceProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}

export function SimulatorEmptySurface({
  icon,
  title,
  description,
  action,
  className,
}: SimulatorEmptySurfaceProps) {
  return (
    <div
      className={cn(
        "bg-bg-base flex h-full min-h-0 w-full flex-1 items-center justify-center p-6",
        className
      )}
    >
      <div className="bg-bg-elevated flex min-h-[260px] w-full max-w-[360px] flex-col items-center justify-center rounded-[28px] px-8 py-9 text-center shadow-[0_22px_70px_color-mix(in_oklch,var(--foreground)_9%,transparent)]">
        <div className="bg-bg-muted/55 text-text-muted flex h-11 w-11 items-center justify-center rounded-2xl">
          {icon}
        </div>
        <p className="text-text-secondary mt-4 text-sm font-medium">{title}</p>
        <p className="text-text-muted mt-1 max-w-[250px] text-xs leading-5">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
