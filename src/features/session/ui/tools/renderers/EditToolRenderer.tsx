/**
 * Edit Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Edit tool (file editing).
 * Shows file path and old_string → new_string changes.
 *
 * BEFORE: 150 LOC (header, animation, error, unique diff view)
 * AFTER: ~40 LOC (only unique diff view logic!)
 */

import { FileEdit, Copy, Check } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { FilePathDisplay } from '../components';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';
import { useCopyToClipboard } from '@/shared/hooks';

export function EditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { copy: copyOld, copied: copiedOld } = useCopyToClipboard();
  const { copy: copyNew, copied: copiedNew } = useCopyToClipboard();

  const { file_path, old_string, new_string } = toolUse.input;

  return (
    <BaseToolRenderer
      toolName="Edit"
      icon={<FileEdit className="w-4 h-4 text-primary" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={true}
      borderColor="info"
      renderMetadata={() => <FilePathDisplay path={file_path} />}
      renderContent={() => (
        <div className="space-y-2">
          {/* Diff View */}
          <div className={cn(chatTheme.blocks.diff.container, 'mt-2')}>
            {/* Old String (Removed) */}
            <div className="bg-background">
              <div className={cn(chatTheme.blocks.diff.header, chatTheme.blocks.diff.removed.header)}>
                <div className="flex items-center justify-between">
                  <span>− Before</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyOld(old_string);
                    }}
                    className="text-xs hover:bg-destructive/20 px-2 py-0.5 rounded transition-colors flex items-center gap-1"
                    title="Copy before"
                  >
                    {copiedOld ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <pre className={cn(chatTheme.blocks.diff.content, chatTheme.blocks.diff.removed.content)}>
                {old_string}
              </pre>
            </div>

            {/* New String (Added) */}
            <div className="bg-background">
              <div className={cn(chatTheme.blocks.diff.header, chatTheme.blocks.diff.added.header)}>
                <div className="flex items-center justify-between">
                  <span>+ After</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyNew(new_string);
                    }}
                    className="text-xs hover:bg-success/20 px-2 py-0.5 rounded transition-colors flex items-center gap-1"
                    title="Copy after"
                  >
                    {copiedNew ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <pre className={cn(chatTheme.blocks.diff.content, chatTheme.blocks.diff.added.content)}>
                {new_string}
              </pre>
            </div>
          </div>
        </div>
      )}
    />
  );
}
