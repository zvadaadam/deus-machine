/**
 * ActionButton - Refined button for user message actions
 *
 * Minimal, icon-only design that integrates seamlessly with user messages.
 * Follows Jony Ive philosophy: purposeful, refined, invisible until needed.
 */

import { type LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chatTheme } from './theme';

interface ActionButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  className
}: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        chatTheme.userActions.button,
        active && chatTheme.userActions.buttonActive,
        className
      )}
      aria-label={label}
      title={label} // Native tooltip, simpler than Tooltip component
    >
      <Icon className={chatTheme.userActions.icon} />
    </button>
  );
}
