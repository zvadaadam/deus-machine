import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
 * Design Philosophy (Jony Ive principles):
 * - Relentless simplicity: No decorative elements
 * - Functional beauty: Every pixel serves the user
 * - Restraint: Information hierarchy through subtlety, not emphasis
 * - Craftsmanship: Typography and spacing create rhythm
 *
 * What's been removed:
 * - Icon box (decorative, no purpose)
 * - Verbose labels ("additions", "deletions")
 * - Always-visible copy button (appears on hover)
 * - Strong background colors (subtle left border instead)
 * - Backdrop blur (unnecessary effect)
 */
export function DiffViewer({
  filePath = '',
  diff = '',
  additions = 0,
  deletions = 0,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

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
   * Design: Subtle left border (no background) + colored text
   * Inspired by GitHub's refined approach
   */
  const renderDiffLine = (line: string, index: number) => {
    const { type, content } = parseDiffLine(line);

    const lineClasses = cn(
      'relative font-mono text-xs leading-relaxed pl-4 pr-4 py-0.5',
      {
        // Additions: subtle left border + green text
        'text-success/90 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-success/30': type === 'addition',

        // Deletions: subtle left border + red text
        'text-destructive/90 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-destructive/30': type === 'deletion',

        // Headers: muted with subtle background
        'text-muted-foreground bg-muted/20': type === 'header',

        // Context: quiet, unobtrusive
        'text-foreground/70': type === 'context',
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
      {/* Header - Fixed at top, clean and purposeful */}
      <div
        className="flex-shrink-0 border-b border-border"
        onMouseEnter={() => setIsHeaderHovered(true)}
        onMouseLeave={() => setIsHeaderHovered(false)}
      >
        {/* File path - single line, no icon clutter */}
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          {/* Left: File path hierarchy */}
          <div className="flex-1 min-w-0 font-mono text-sm">
            {pathContext && (
              <span className="text-muted-foreground/50">
                {pathContext}
              </span>
            )}
            <span className="text-foreground">
              {filename || 'Untitled'}
            </span>
          </div>

          {/* Right: Stats + Copy button (appears on hover) */}
          <div className="flex items-center gap-4">
            {/* Stats: Just numbers, no labels */}
            {(additions > 0 || deletions > 0) && (
              <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                {additions > 0 && (
                  <span className="text-success/80">+{additions}</span>
                )}
                {deletions > 0 && (
                  <span className="text-destructive/80">−{deletions}</span>
                )}
              </div>
            )}

            {/* Copy button: Icon only, appears on hover */}
            {!isLoading && !hasError && diff.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyDiff}
                className={cn(
                  'h-6 w-6 transition-opacity duration-200',
                  isHeaderHovered || copied ? 'opacity-100' : 'opacity-0'
                )}
                title="Copy diff"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Diff content - Scrollable with native overflow */}
      <div className="relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth motion-reduce:scroll-auto min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground/60">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
              <span className="text-sm">Loading diff...</span>
            </div>
          </div>
        ) : hasError ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground/60">
            <div className="flex flex-col items-center gap-2 text-center max-w-sm">
              <p className="text-sm">{diff}</p>
            </div>
          </div>
        ) : diff.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground/60">
            <p className="text-sm">No changes</p>
          </div>
        ) : (
          <div className="py-2">
            {diffLines.map((line, index) => renderDiffLine(line, index))}
          </div>
        )}
      </div>
    </div>
  );
}
