import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { parseDiff, highlightDiffLine, calculateSkippedLines, type DiffHunk, type DiffLine } from '@/shared/lib/syntaxHighlighter';
import { detectLanguageFromPath } from '@/features/session/ui/tools/utils/detectLanguage';
import { computeWordDiff, applyWordHighlights } from '@/shared/lib/wordDiff';

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
 * Implementation:
 * - Two-pass rendering: syntax highlighting (Shiki) + word-level diff overlays
 * - Word-level highlights show exact changes within lines (saturated backgrounds)
 * - Performance optimized: O(n) greedy word matching, smart caching
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
  const [theme, setTheme] = useState<'github-dark' | 'github-light'>('github-dark');

  /**
   * Detect current theme from document.documentElement.classList
   * Watches for theme changes via MutationObserver
   */
  useEffect(() => {
    const detectTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setTheme(isDark ? 'github-dark' : 'github-light');
    };

    // Initial detection
    detectTheme();

    // Watch for theme changes
    const observer = new MutationObserver(detectTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

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
   * Parse and highlight diff with syntax highlighting + word-level highlights
   * Optimized for performance:
   * - Only compute word diff for adjacent deletion-addition pairs
   * - Skip word diff for very long lines (>200 chars)
   * - Process in batches to avoid blocking
   */
  useEffect(() => {
    let cancelled = false;

    const highlightDiff = async () => {
      if (!diff || diff === 'Loading diff...' || diff.includes('Error loading diff')) {
        if (!cancelled) setHighlightedHunks([]);
        return;
      }

      if (!cancelled) setIsHighlighting(true);

      // Parse diff to extract code hunks (removes git metadata)
      const hunks = parseDiff(diff);
      const highlighted: HighlightedHunk[] = [];

      // Highlight each hunk's lines with word-level precision
      for (const hunk of hunks) {
        const highlightedLines: HighlightedDiffLine[] = [];

        // First pass: syntax highlight all lines with current theme
        const syntaxHighlighted = await Promise.all(
          hunk.lines.map(async (line) => ({
            ...line,
            syntaxHtml: await highlightDiffLine(line.content, language, theme),
          }))
        );

        // Second pass: apply word-level highlights ONLY to adjacent deletion-addition pairs
        let wordDiffCache = new Map<number, { oldRanges: any[], newRanges: any[] }>();

        for (let i = 0; i < syntaxHighlighted.length; i++) {
          const line = syntaxHighlighted[i];
          let finalHtml = line.syntaxHtml;

          // Only compute word diff for adjacent pairs and short lines
          const MAX_LINE_LENGTH = 200;

          if (line.type === 'deletion' && i + 1 < syntaxHighlighted.length) {
            const nextLine = syntaxHighlighted[i + 1];

            // Only if next line is an addition AND both lines are reasonably short
            if (
              nextLine.type === 'addition' &&
              line.content.length < MAX_LINE_LENGTH &&
              nextLine.content.length < MAX_LINE_LENGTH
            ) {
              // Compute word diff once and cache it
              if (!wordDiffCache.has(i)) {
                const diffResult = computeWordDiff(line.content, nextLine.content);
                wordDiffCache.set(i, diffResult);
              }

              const { oldRanges } = wordDiffCache.get(i)!;

              // Apply highlights only if there are meaningful differences
              if (oldRanges.length > 0 && oldRanges.length < 10) {
                finalHtml = applyWordHighlights(line.syntaxHtml, line.content, oldRanges, 'deletion');
              }
            }
          } else if (line.type === 'addition' && i > 0) {
            const prevLine = syntaxHighlighted[i - 1];

            // Only if previous line is a deletion AND both lines are reasonably short
            if (
              prevLine.type === 'deletion' &&
              line.content.length < MAX_LINE_LENGTH &&
              prevLine.content.length < MAX_LINE_LENGTH
            ) {
              // Use cached result from deletion
              const cached = wordDiffCache.get(i - 1);
              if (cached) {
                const { newRanges } = cached;

                // Apply highlights only if there are meaningful differences
                if (newRanges.length > 0 && newRanges.length < 10) {
                  finalHtml = applyWordHighlights(line.syntaxHtml, line.content, newRanges, 'addition');
                }
              }
            }
          }

          highlightedLines.push({
            ...line,
            highlightedCode: finalHtml,
          });
        }

        highlighted.push({
          ...hunk,
          lines: highlightedLines,
        });
      }

      if (!cancelled) {
        setHighlightedHunks(highlighted);
        setIsHighlighting(false);
      }
    };

    highlightDiff();
    return () => { cancelled = true; };
  }, [diff, language, theme]);

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
   * GitHub-inspired design using CSS variables:
   * - Theme-aware backgrounds (--diff-addition-bg / --diff-deletion-bg)
   * - Line numbers with gutter colors
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
            // Theme-aware backgrounds using CSS variables
            'bg-[var(--diff-addition-bg)]': type === 'addition',
            'bg-[var(--diff-deletion-bg)]': type === 'deletion',
          }
        )}
      >
        {/* Line number - right-aligned, muted */}
        <span
          className={cn(
            'flex-shrink-0 w-12 pr-4 text-right select-none',
            {
              'bg-[var(--diff-addition-gutter)] text-[var(--diff-addition-text)]': type === 'addition',
              'bg-[var(--diff-deletion-gutter)] text-[var(--diff-deletion-text)]': type === 'deletion',
              'bg-[var(--diff-line-number-bg)] text-[var(--diff-line-number)]': type === 'context',
            }
          )}
        >
          {lineNum}
        </span>

        {/* Code content - syntax highlighted with preserved whitespace */}
        <span
          className={cn('flex-1 pr-4 py-0.5 whitespace-pre', {
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
