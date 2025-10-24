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
      icon={<Cpu className="w-4 h-4 text-violet-600 dark:text-violet-400" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      borderColor={isError ? 'error' : 'default'}
      backgroundColor={isError ? 'bg-destructive/5' : 'bg-violet-50/20 dark:bg-violet-950/10'}
      renderSummary={() => (
        description && (
          <span className="text-xs text-muted-foreground ml-2 truncate">
            {description}
          </span>
        )
      )}
      renderMetadata={() => (
        <div className="px-2 pb-1 space-y-1">
          {description && (
            <div className="flex items-start gap-2 text-sm">
              <Sparkles className="w-3 h-3 text-violet-600 dark:text-violet-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-violet-700 dark:text-violet-300">
                  {description}
                </div>
              </div>
            </div>
          )}
          {subagent_type && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Type:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{subagent_type}</code>
            </div>
          )}
        </div>
      )}
      renderContent={() => (
        <div className="px-2 pb-2 space-y-2">
          {/* Agent prompt */}
          {prompt && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Task Prompt:</div>
              <div className="text-xs bg-muted/50 border border-border rounded p-2 max-h-60 overflow-y-auto">
                <pre className="whitespace-pre-wrap break-words m-0 font-mono">{prompt}</pre>
              </div>
            </div>
          )}

          {/* Agent result */}
          {hasResult && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Agent Report:</div>
              <div className="text-xs bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800/40 rounded p-2 max-h-60 overflow-y-auto">
                <pre className="whitespace-pre-wrap break-words m-0">{result}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    />
  );
}
