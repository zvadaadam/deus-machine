import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { parseDiff, highlightDiffLine, type DiffHunk, type DiffLine } from '@/shared/lib/syntaxHighlighter';
import { detectLanguageFromPath } from '@/features/session/ui/tools/utils/detectLanguage';

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
interface HighlightedDiffLine extends DiffLine {
  highlightedCode: string;
}

interface HighlightedHunk extends Omit<DiffHunk, 'lines'> {
  lines: HighlightedDiffLine[];
}

export function DiffViewer({
  filePath = '',
  diff = '',
  additions = 0,
  deletions = 0,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const [highlightedHunks, setHighlightedHunks] = useState<HighlightedHunk[]>([]);
  const [isHighlighting, setIsHighlighting] = useState(false);

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
   * Detect programming language from file extension
   * Used for syntax highlighting
   */
  const language = filePath ? detectLanguageFromPath(filePath) : 'text';

  /**
   * Parse and highlight diff with syntax highlighting
   * Runs when diff or filePath changes
   */
  useEffect(() => {
    const highlightDiff = async () => {
      if (!diff || diff === 'Loading diff...' || diff.includes('Error loading diff')) {
        setHighlightedHunks([]);
        return;
      }

      setIsHighlighting(true);

      // Parse diff to extract code hunks (removes git metadata)
      const hunks = parseDiff(diff);
      const highlighted: HighlightedHunk[] = [];

      // Highlight each hunk's lines
      for (const hunk of hunks) {
        const highlightedLines: HighlightedDiffLine[] = [];

        for (const line of hunk.lines) {
          const highlightedCode = await highlightDiffLine(line.content, language);
          highlightedLines.push({
            ...line,
            highlightedCode,
          });
        }

        highlighted.push({
          ...hunk,
          lines: highlightedLines,
        });
      }

      setHighlightedHunks(highlighted);
      setIsHighlighting(false);
    };

    highlightDiff();
  }, [diff, language]);

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
   * Render a single diff line with line numbers
   * Design: Line number (left) | Code (syntax highlighted)
   * Subtle 2px left border for additions/deletions
   */
  const renderDiffLine = (line: HighlightedDiffLine, index: number) => {
    const { type, highlightedCode, oldLineNum, newLineNum } = line;

    // Display line number (prefer new line for additions, old line for deletions)
    const lineNum = type === 'deletion' ? oldLineNum : newLineNum;

    return (
      <div
        key={index}
        className={cn(
          'relative flex items-start font-mono text-xs leading-relaxed',
          {
            // Subtle left border for additions/deletions
            'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-success/30': type === 'addition',
            'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-destructive/30': type === 'deletion',
          }
        )}
      >
        {/* Line number - right-aligned, muted */}
        <span className="flex-shrink-0 w-12 pr-4 text-right text-muted-foreground/50 select-none">
          {lineNum}
        </span>

        {/* Code content - syntax highlighted */}
        <span
          className={cn('flex-1 pr-4', {
            'text-success/90': type === 'addition',
            'text-destructive/90': type === 'deletion',
            'text-foreground/80': type === 'context',
          })}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </div>
    );
  };

  const isLoading = diff === 'Loading diff...' || isHighlighting;
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
            {highlightedHunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex} className="mb-4">
                {hunk.lines.map((line, lineIndex) => renderDiffLine(line, lineIndex))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
