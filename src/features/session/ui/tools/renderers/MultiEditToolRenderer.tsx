/**
 * MultiEdit Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the MultiEdit tool (multiple edits to one file)
 * Shows all edits with before/after diffs
 *
 * BEFORE: 176 LOC
 * AFTER: ~115 LOC
 */

import { FilePenLine, Copy, Check } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { FilePathDisplay } from '../components/FilePathDisplay';
import { useCopyToClipboard } from '@/shared/hooks/useCopyToClipboard';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

interface Edit {
  old_string: string;
  new_string: string;
}

export function MultiEditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, edits } = toolUse.input;
  const isError = toolResult?.is_error;
  const editCount = edits?.length || 0;

  // Use separate copy hook instances for old and new strings
  const { copy: copyOld, copied: copiedOld } = useCopyToClipboard();
  const { copy: copyNew, copied: copiedNew } = useCopyToClipboard();

  return (
    <BaseToolRenderer
      toolName="Multi Edit"
      icon={<FilePenLine className="w-4 h-4 text-success" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={true}
      borderColor={isError ? 'error' : 'success'}
      backgroundColor={isError ? 'bg-destructive/5' : undefined}
      renderSummary={() => (
        <span className="text-xs text-muted-foreground ml-2">
          {editCount} edit{editCount !== 1 ? 's' : ''}
        </span>
      )}
      renderMetadata={() => <FilePathDisplay path={file_path} />}
      renderContent={() => {
        if (!edits || edits.length === 0) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              No edits provided
            </div>
          );
        }

        return (
          <div className="px-2 pb-2 space-y-3">
            <div className="text-xs text-muted-foreground">
              {editCount} edit{editCount !== 1 ? 's' : ''} to apply:
            </div>

            {edits.map((edit: Edit, index: number) => (
              <div key={index} className="space-y-1">
                {/* Edit number header */}
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="bg-muted px-1.5 py-0.5 rounded">
                    Edit {index + 1}/{editCount}
                  </span>
                </div>

                {/* Side-by-side diff */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {/* Before (old_string) */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 py-1 bg-destructive/10 rounded-t border-l-2 border-l-destructive">
                      <span className="font-medium text-destructive">Before</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyOld(edit.old_string);
                        }}
                        className="p-1 hover:bg-destructive/20 rounded transition-colors"
                        title="Copy before"
                        aria-label="Copy before text"
                      >
                        {copiedOld ? (
                          <Check className="w-3 h-3 text-destructive" />
                        ) : (
                          <Copy className="w-3 h-3 text-destructive" />
                        )}
                      </button>
                    </div>
                    <pre className="p-2 bg-destructive/5 rounded-b border border-destructive/20 overflow-x-auto font-mono whitespace-pre-wrap break-words text-destructive-foreground">
                      {edit.old_string}
                    </pre>
                  </div>

                  {/* After (new_string) */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 py-1 bg-success/10 rounded-t border-l-2 border-l-success">
                      <span className="font-medium text-success">After</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyNew(edit.new_string);
                        }}
                        className="p-1 hover:bg-success/20 rounded transition-colors"
                        title="Copy after"
                        aria-label="Copy after text"
                      >
                        {copiedNew ? (
                          <Check className="w-3 h-3 text-success" />
                        ) : (
                          <Copy className="w-3 h-3 text-success" />
                        )}
                      </button>
                    </div>
                    <pre className="p-2 bg-success/5 rounded-b border border-success/20 overflow-x-auto font-mono whitespace-pre-wrap break-words text-success-foreground">
                      {edit.new_string}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
