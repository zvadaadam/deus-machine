/**
 * LS Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the LS tool (list directory contents)
 * Shows directory path and file listings
 *
 * BEFORE: 154 LOC
 * AFTER: ~95 LOC
 */

import { FolderOpen, File, Folder } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function LSToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { path } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse directory listing
  const parseListings = (content: string): string[] => {
    if (!content || content.trim() === '') {
      return [];
    }
    return content.split('\n').filter(line => line.trim().length > 0);
  };

  const listings = toolResult && !isError ? parseListings(
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content)
  ) : [];

  const hasListings = listings.length > 0;
  const itemCount = listings.length;

  // Determine if item is likely a directory (ends with /)
  const isDirectory = (item: string) => item.endsWith('/');

  // Extract directory name from path
  const dirName = path.split('/').pop() || path;

  return (
    <BaseToolRenderer
      toolName="List Directory"
      icon={<FolderOpen className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-xs text-muted-foreground">
          {dirName} • {hasListings ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : 'empty'}
        </span>
      )}
      renderContent={() => {
        // Empty directory message
        if (!hasListings) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              Directory is empty
            </div>
          );
        }

        // Directory contents
        return (
          <div className="px-2 pb-2">
            <div className="text-xs text-muted-foreground mb-1">Contents ({itemCount}):</div>
            <div className="max-h-60 overflow-y-auto space-y-0.5 pr-1">
              {listings.map((item, index) => {
                const isDir = isDirectory(item);
                const cleanItem = item.replace(/\/$/, ''); // Remove trailing slash for display

                return (
                  <div
                    key={index}
                    className="text-xs font-mono bg-muted/50 hover:bg-muted transition-colors px-2 py-1 rounded group flex items-center gap-2"
                  >
                    {isDir ? (
                      <Folder className="w-3 h-3 text-info flex-shrink-0" aria-hidden="true" />
                    ) : (
                      <File className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                    )}
                    <span className="flex-1 break-all">{cleanItem}</span>
                    {isDir && (
                      <span className="text-[0.65rem] text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity">
                        DIR
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }}
    />
  );
}
