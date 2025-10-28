/**
 * ChatMarkdown - Markdown renderer optimized for chat messages
 *
 * Uses `.markdown-content` class from global.css for styling.
 * Styles defined in vanilla CSS (Tailwind v4 doesn't support @apply).
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
      proseClassName="markdown-content"
    >
      {children}
    </MarkdownRenderer>
  );
}
