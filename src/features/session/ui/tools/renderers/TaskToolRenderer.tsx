/**
 * Task Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Task tool (Agent spawning)
 * Displays sub-agent tasks with description and detailed prompt
 *
 * BEFORE: 141 LOC
 * AFTER: ~85 LOC
 */

import { Cpu, Sparkles } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function TaskToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { description, prompt, subagent_type } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse result if it's an object
  const result = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasResult = result && result.trim().length > 0;

  return (
    <BaseToolRenderer
      toolName="Spawn Agent"
      icon={<Cpu className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-[12px] text-muted-foreground truncate">
          {description || subagent_type || 'Running agent'}
        </span>
      )}
      renderContent={() => (
        <div className="px-2 pb-2 space-y-2">
          {/* Agent prompt */}
          {prompt && (
            <div className="text-xs bg-muted/50 border border-border rounded p-2 max-h-60 overflow-y-auto">
              <pre className="whitespace-pre-wrap break-words m-0 font-mono">{prompt}</pre>
            </div>
          )}

          {/* Agent result */}
          {hasResult && (
            <div className="text-xs bg-muted/50 border border-border rounded p-2 max-h-60 overflow-y-auto mt-2">
              <pre className="whitespace-pre-wrap break-words m-0">{result}</pre>
            </div>
          )}
        </div>
      )}
    />
  );
}
