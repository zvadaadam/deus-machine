/**
 * ChatMarkdown - Markdown renderer optimized for chat messages
 *
 * Dense, IDE-friendly typography that matches tool call density.
 * Uses our refined spacing and hierarchy from TextBlock improvements.
 *
 * Features:
 * - Compact 14px base font (matches tool density)
 * - Clear hierarchy with bold headings
 * - Visible bullet points
 * - Shiki syntax highlighting
 * - Copy buttons on code blocks
 */

import { MarkdownRenderer } from './MarkdownRenderer';
import { cn } from '@/shared/lib/utils';

interface ChatMarkdownProps {
  children: string;
  className?: string;
  /** Allow raw HTML (secured with sanitization) */
  allowHtml?: boolean;
}

export function ChatMarkdown({ children, className, allowHtml = false }: ChatMarkdownProps) {
  return (
    <MarkdownRenderer
      allowHtml={allowHtml}
      className={className}
      proseClassName={cn(
        // Base prose with dark mode support
        'prose prose-sm dark:prose-invert max-w-full min-w-0',

        // COMPACT IDE TYPOGRAPHY (14px base, tight line-height)
        'text-[14px] leading-[1.6]',

        // Paragraphs - breathing room without bloat
        'prose-p:my-3 prose-p:leading-[1.6]',

        // Headings - BOLD & VISIBLE hierarchy
        'prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-foreground',
        'prose-h1:text-[20px] prose-h1:mt-6 prose-h1:mb-3',
        'prose-h2:text-[18px] prose-h2:mt-5 prose-h2:mb-2',
        'prose-h3:text-[16px] prose-h3:mt-4 prose-h3:mb-2',

        // Links - primary color with underline
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',

        // Inline code - pill style with medium weight
        'prose-code:bg-muted/70 prose-code:px-1.5 prose-code:py-0.5',
        'prose-code:rounded prose-code:text-[13px] prose-code:font-mono prose-code:font-medium',
        'prose-code:before:content-none prose-code:after:content-none',

        // Code blocks - with Shiki highlighting
        'prose-pre:bg-muted/70 prose-pre:border prose-pre:border-border/60',
        'prose-pre:rounded-lg prose-pre:p-4 prose-pre:my-4',
        'prose-pre:overflow-x-auto',

        // Lists - VISIBLE bullets with proper indentation
        'prose-ul:my-3 prose-ul:list-disc prose-ul:pl-5',
        'prose-ol:my-3 prose-ol:list-decimal prose-ol:pl-5',
        'prose-li:my-1.5 prose-li:leading-[1.6]',
        'marker:text-foreground/60',

        // Strong/Bold - ACTUALLY BOLD
        'prose-strong:font-bold prose-strong:text-foreground',

        // Blockquotes
        'prose-blockquote:border-l-2 prose-blockquote:border-l-primary',
        'prose-blockquote:bg-muted/30 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:my-3',

        // Tables - compact borders
        'prose-table:border prose-table:border-border prose-table:my-4',
        'prose-th:bg-muted prose-th:border prose-th:border-border prose-th:p-2',
        'prose-td:border prose-td:border-border prose-td:p-2',

        // Horizontal rules
        'prose-hr:border-border/40 prose-hr:my-6'
      )}
    >
      {children}
    </MarkdownRenderer>
  );
}
