import { cn } from '@/lib/utils';
import type { ReactNode, ElementType } from 'react';

interface ShimmerProps {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  isShimmering?: boolean;
  duration?: number; // For backwards compatibility, not used
}

export function Shimmer({
  children,
  as: Component = 'div',
  className,
  isShimmering = true,
}: ShimmerProps) {
  return (
    <Component
      className={cn(
        isShimmering
          ? 'bg-clip-text text-transparent bg-[linear-gradient(100deg,theme(colors.primary.DEFAULT/0.4)_30%,theme(colors.primary.DEFAULT/0.6)_48%,theme(colors.primary.DEFAULT/0.6)_52%,theme(colors.primary.DEFAULT/0.4)_70%)] animate-text-shimmer bg-[length:200%_100%]'
          : 'text-primary/40',
        className
      )}
    >
      {children}
    </Component>
  );
}

// Backwards compatibility alias
export const TextShimmer = Shimmer;
