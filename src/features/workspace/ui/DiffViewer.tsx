import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { highlightDiffLine } from '@/shared/lib/syntaxHighlighter';
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
interface HighlightedLine {
  marker: string;
  highlightedCode: string;
  type: 'addition' | 'deletion' | 'context' | 'header';
  originalLine: string;
}

export function DiffViewer({
  filePath = '',
  diff = '',
  additions = 0,
  deletions = 0,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const [highlightedLines, setHighlightedLines] = useState<HighlightedLine[]>([]);
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
   * Highlight diff lines with syntax highlighting
   * Runs when diff or filePath changes
   */
  useEffect(() => {
    const highlightDiff = async () => {
      if (!diff || diff === 'Loading diff...' || diff.includes('Error loading diff')) {
        setHighlightedLines([]);
        return;
      }

      setIsHighlighting(true);
      const lines = diff.split('\n');
      const highlighted: HighlightedLine[] = [];

      // Highlight all lines
      for (const line of lines) {
        const result = await highlightDiffLine(line, language);
        highlighted.push(result);
      }

      setHighlightedLines(highlighted);
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
   * Render highlighted diff line with syntax highlighting
   * Design: Subtle left border (no background) + syntax colors
   */
  const renderHighlightedDiffLine = (line: HighlightedLine, index: number) => {
    const { type, marker, highlightedCode } = line;

    const lineClasses = cn(
      'relative font-mono text-xs leading-relaxed pl-4 pr-4 py-0.5 flex items-start gap-2',
      {
        // Additions: subtle left border + green tint
        'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-success/30': type === 'addition',

        // Deletions: subtle left border + red tint
        'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-destructive/30': type === 'deletion',

        // Headers: muted with subtle background
        'text-muted-foreground bg-muted/20': type === 'header',
      }
    );

    return (
      <div key={index} className={lineClasses}>
        {/* Diff marker (+/-) with color */}
        {marker && (
          <span
            className={cn('flex-shrink-0 select-none', {
              'text-success/80': type === 'addition',
              'text-destructive/80': type === 'deletion',
            })}
          >
            {marker}
          </span>
        )}

        {/* Syntax-highlighted code */}
        <span
          className="flex-1 min-w-0"
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
            {highlightedLines.map((line, index) => renderHighlightedDiffLine(line, index))}
          </div>
        )}
      </div>
    </div>
  );
}
