import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { parseDiff, highlightDiffLine, calculateSkippedLines, type DiffHunk, type DiffLine } from '@/shared/lib/syntaxHighlighter';
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
 * Design Philosophy (Jony Ive principles applied to diffs):
 * 1. **Hierarchy through contrast** - Changed content must announce itself
 *    - Light backgrounds for changed lines (GitHub pattern) - essential, not decorative
 *    - Context lines remain quiet and unobtrusive
 *
 * 2. **Visual structure serves navigation**
 *    - Gap indicators show hidden code sections
 *    - Line numbers provide orientation
 *    - Syntax highlighting reveals code structure
 *
 * 3. **Confident design choices**
 *    - Full-strength backgrounds where they matter (additions/deletions)
 *    - No timid opacity on critical elements
 *    - Backgrounds ARE appropriate when they create essential hierarchy
 *
 * 4. **What the code changed is the hero**
 *    - Syntax highlighting shows structure
 *    - Clean typography maintains readability
 *    - Everything else supports this primary purpose
 *
 * Future enhancement: Word-level highlighting (saturated backgrounds for exact changes)
 * This would show WHAT changed within a line, not just which lines changed.
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
   * GitHub-inspired design:
   * - Light backgrounds for changed lines (#e6ffec / #ffebe9)
   * - Line numbers on the left
   * - Syntax-highlighted code
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
            // GitHub-style backgrounds for changed lines
            'bg-[oklch(0.96_0.03_145)]': type === 'addition',   // Light mint green
            'bg-[oklch(0.96_0.03_25)]': type === 'deletion',     // Light rose
          }
        )}
      >
        {/* Line number - right-aligned, muted */}
        <span
          className={cn(
            'flex-shrink-0 w-12 pr-4 text-right select-none',
            {
              'text-[oklch(0.45_0.12_145)] bg-[oklch(0.92_0.04_145)]': type === 'addition',
              'text-[oklch(0.45_0.12_25)] bg-[oklch(0.92_0.04_25)]': type === 'deletion',
              'text-muted-foreground/40': type === 'context',
            }
          )}
        >
          {lineNum}
        </span>

        {/* Code content - syntax highlighted */}
        <span
          className={cn('flex-1 pr-4 py-0.5', {
            'text-foreground': type === 'addition' || type === 'deletion',
            'text-foreground/80': type === 'context',
          })}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </div>
    );
  };

  /**
   * Render gap indicator between hunks
   * Shows how many lines are hidden
   */
  const renderGapIndicator = (skippedLines: number, key: string) => {
    if (skippedLines === 0) return null;

    return (
      <div
        key={key}
        className="flex items-center gap-3 py-3 px-4 my-2 text-xs text-muted-foreground/60 bg-muted/20 border-y border-border/20"
      >
        <div className="flex-1 h-px bg-border/20" />
        <span className="font-mono">
          {skippedLines} unchanged line{skippedLines !== 1 ? 's' : ''}
        </span>
        <div className="flex-1 h-px bg-border/20" />
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
          <div>
            {highlightedHunks.map((hunk, hunkIndex) => {
              // Calculate skipped lines between this and previous hunk
              const skippedLines = hunkIndex > 0
                ? calculateSkippedLines(highlightedHunks[hunkIndex - 1], hunk)
                : 0;

              return (
                <div key={hunkIndex}>
                  {/* Gap indicator if there are skipped lines */}
                  {skippedLines > 0 && renderGapIndicator(skippedLines, `gap-${hunkIndex}`)}

                  {/* Hunk lines */}
                  <div>
                    {hunk.lines.map((line, lineIndex) => renderDiffLine(line, lineIndex))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
