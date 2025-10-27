import { useState } from 'react';
import { FileCode, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/shared/lib/utils';

interface DiffViewerProps {
  filePath?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
}

/**
 * DiffViewer - Inline git diff viewer component
 *
 * Renders file diffs inline within the main content area as a tab.
 * Features:
 * - Clean header with file path and change statistics
 * - Syntax-highlighted unified diff format (+ green, - red)
 * - Copy diff button for easy sharing
 * - Smooth scrolling with ScrollArea
 *
 * Design: Minimalist, inspired by Linear/Stripe/GitHub
 */
export function DiffViewer({
  filePath = '',
  diff = '',
  additions = 0,
  deletions = 0,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);

  /**
   * Extract filename and path context from full file path
   * Example: "src/features/workspace/ui/DiffViewer.tsx"
   * → path: "src/features/workspace/ui/"
   * → filename: "DiffViewer.tsx"
   */
  const pathParts = filePath.split('/').filter(part => part.length > 0);
  const filename = pathParts.pop() || filePath;
  const pathContext = pathParts.length > 0 ? pathParts.join('/') + '/' : '';

  /**
   * Copy diff content to clipboard
   */
  const handleCopyDiff = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy diff:', error);
    }
  };

  /**
   * Parse diff line to determine type and styling
   * Returns: { type: 'addition' | 'deletion' | 'context' | 'header', content: string }
   */
  const parseDiffLine = (line: string) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { type: 'addition' as const, content: line };
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { type: 'deletion' as const, content: line };
    }
    if (line.startsWith('@@')) {
      return { type: 'header' as const, content: line };
    }
    return { type: 'context' as const, content: line };
  };

  /**
   * Render individual diff line with appropriate styling
   */
  const renderDiffLine = (line: string, index: number) => {
    const { type, content } = parseDiffLine(line);

    const lineClasses = cn(
      'font-mono text-xs leading-relaxed px-4 py-0.5',
      {
        'bg-success/10 text-success-foreground': type === 'addition',
        'bg-destructive/10 text-destructive-foreground': type === 'deletion',
        'bg-muted/30 text-muted-foreground font-semibold': type === 'header',
        'text-foreground/80': type === 'context',
      }
    );

    return (
      <div key={index} className={lineClasses}>
        {content}
      </div>
    );
  };

  const diffLines = diff.split('\n');
  const isLoading = diff === 'Loading diff...';
  const hasError = diff.includes('Error loading diff') || diff === 'No diff available';

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header - Fixed at top */}
      <div className="flex-shrink-0 border-b border-border/40 bg-background/95 backdrop-blur-sm">
        {/* File path and filename */}
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                <FileCode className="w-4 h-4 text-primary" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {pathContext && (
                <div className="text-xs text-muted-foreground/60 font-mono truncate">
                  {pathContext}
                </div>
              )}
              <div className="text-sm font-semibold text-foreground truncate">
                {filename || 'Untitled'}
              </div>
            </div>
          </div>
        </div>

        {/* Stats and actions */}
        <div className="px-4 pb-3 flex items-center justify-between gap-4">
          {/* Change statistics */}
          <div className="flex items-center gap-3 font-mono text-xs">
            {additions > 0 && (
              <span className="text-success font-semibold">
                +{additions} {additions === 1 ? 'addition' : 'additions'}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-destructive font-semibold">
                -{deletions} {deletions === 1 ? 'deletion' : 'deletions'}
              </span>
            )}
            {additions === 0 && deletions === 0 && !isLoading && (
              <span className="text-muted-foreground">No changes</span>
            )}
          </div>

          {/* Copy button */}
          {!isLoading && !hasError && diff.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyDiff}
              className="h-7 px-2 text-xs gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Diff
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Diff content - Scrollable */}
      <ScrollArea className="flex-1">
        <div className="min-h-full">
          {isLoading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                <span className="text-sm">Loading diff...</span>
              </div>
            </div>
          ) : hasError ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <div className="flex flex-col items-center gap-2 text-center max-w-sm">
                <FileCode className="w-12 h-12 text-muted-foreground/40" />
                <p className="text-sm font-medium">{diff}</p>
                <p className="text-xs text-muted-foreground/60">
                  The diff for this file could not be loaded
                </p>
              </div>
            </div>
          ) : diff.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <FileCode className="w-12 h-12 text-muted-foreground/40" />
                <p className="text-sm">No diff content available</p>
              </div>
            </div>
          ) : (
            <div className="py-2">
              {diffLines.map((line, index) => renderDiffLine(line, index))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
