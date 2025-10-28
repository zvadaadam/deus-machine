/**
 * Default Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Fallback renderer for unknown/unsupported tools.
 *
 * BEFORE: 70 LOC
 * AFTER: ~25 LOC
 */

import { Wrench } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import type { ToolRendererProps } from '../../chat-types';

export function DefaultToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  // Extract first input value as preview (if available)
  const firstInputKey = Object.keys(toolUse.input || {})[0];
  const firstInputValue = firstInputKey ? String(toolUse.input[firstInputKey]).substring(0, 40) : '';

  return (
    <BaseToolRenderer
      toolName={toolUse.name || 'Unknown Tool'}
      icon={<Wrench className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        firstInputValue ? (
          <span className="font-mono text-[12px] text-muted-foreground truncate">
            {firstInputValue}
          </span>
        ) : undefined
      )}
      renderContent={({ toolResult }) => {
        if (!toolResult) return <div className="text-xs text-muted-foreground">No result yet</div>;

        return (
          <pre className="p-2 rounded font-mono text-xs bg-muted/30 overflow-x-auto max-h-[200px] overflow-y-auto">
            {typeof toolResult.content === 'object'
              ? JSON.stringify(toolResult.content, null, 2)
              : toolResult.content}
          </pre>
        );
      }}
    />
  );
}
