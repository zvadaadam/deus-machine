import { cn } from '@/lib/utils';
import type { ReactNode, ElementType } from 'react';

interface ShimmerProps {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  isShimmering?: boolean;
  duration?: number; // For backwards compatibility, not used
  variant?: 'primary' | 'blue' | 'yellow' | 'custom';
}

const variantClasses = {
  primary: 'bg-[linear-gradient(100deg,theme(colors.primary.DEFAULT/0.4)_30%,theme(colors.primary.DEFAULT/0.6)_48%,theme(colors.primary.DEFAULT/0.6)_52%,theme(colors.primary.DEFAULT/0.4)_70%)]',
  blue: 'bg-[linear-gradient(100deg,theme(colors.blue.700/0.4)_30%,theme(colors.blue.300)_48%,theme(colors.blue.300)_52%,theme(colors.blue.700/0.4)_70%)] dark:bg-[linear-gradient(100deg,theme(colors.blue.600/0.4)_30%,theme(colors.blue.400)_48%,theme(colors.blue.400)_52%,theme(colors.blue.600/0.4)_70%)]',
  yellow: 'bg-[linear-gradient(100deg,theme(colors.yellow.600/0.4)_30%,theme(colors.yellow.200)_48%,theme(colors.yellow.200)_52%,theme(colors.yellow.600/0.4)_70%)] dark:bg-[linear-gradient(100deg,theme(colors.yellow.700/0.4)_30%,theme(colors.yellow.400)_48%,theme(colors.yellow.400)_52%,theme(colors.yellow.700/0.4)_70%)]',
  custom: '', // Allow full customization via className
};

export function Shimmer({
  children,
  as: Component = 'div',
  className,
  isShimmering = true,
  variant = 'primary',
}: ShimmerProps) {
  return (
    <Component
      className={cn(
        isShimmering && 'bg-clip-text text-transparent animate-text-shimmer bg-[length:200%_100%]',
        isShimmering && variantClasses[variant],
        !isShimmering && 'text-primary/40',
        className
      )}
    >
      {children}
    </Component>
  );
}

// Backwards compatibility alias
export const TextShimmer = Shimmer;
