/**
 * ActionButton - Refined button for user message actions
 *
 * Compact button with icon and optional label text.
 * Designed to sit below user messages, visible on hover.
 */

import { type LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chatTheme } from './theme';

interface ActionButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  showLabel = true,
  className
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        chatTheme.userActions.button,
        active && chatTheme.userActions.buttonActive,
        className
      )}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon className={chatTheme.userActions.icon} />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
