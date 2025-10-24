/**
 * Tool Error Component
 *
 * Shared component for displaying tool execution errors consistently.
 * Used by all tool renderers to show error messages in a standardized format.
 */

import { cn } from '@/shared/lib/utils';
import { AlertCircle } from 'lucide-react';

interface ToolErrorProps {
  content: string | object;
  className?: string;
}

export function ToolError({ content, className }: ToolErrorProps) {
  // Stringify objects for display
  const errorText = typeof content === 'object'
    ? JSON.stringify(content, null, 2)
    : content;

  return (
    <div
      className={cn(
        'p-2 mx-2 mb-2 rounded',
        'bg-destructive/10 border border-destructive/30',
        'flex gap-2',
        className
      )}
    >
      <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
      <pre className="text-xs text-destructive-foreground font-mono m-0 whitespace-pre-wrap break-words flex-1">
        {errorText}
      </pre>
    </div>
  );
}
