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
          <span className="font-mono text-xs text-muted-foreground truncate">
            {firstInputValue}
          </span>
        ) : undefined
      )}
      renderContent={({ toolUse, toolResult }) => {
        return (
          <div className="space-y-3 px-2 pb-2">
            {/* Input */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">Input:</div>
              <pre className="p-3 rounded-lg font-mono text-xs bg-muted/60 overflow-x-auto max-h-[200px] overflow-y-auto border border-border/60">
                {JSON.stringify(toolUse.input, null, 2)}
              </pre>
            </div>

            {/* Output */}
            {toolResult && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">Output:</div>
                <pre className="p-3 rounded-lg font-mono text-xs bg-muted/60 overflow-x-auto max-h-[200px] overflow-y-auto border border-border/60">
                  {typeof toolResult.content === 'object'
                    ? JSON.stringify(toolResult.content, null, 2)
                    : toolResult.content}
                </pre>
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
