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
 * - CSS-based syntax highlighting (instant rendering)
 * - Copy buttons on code blocks
 */

import { MarkdownRenderer } from "./MarkdownRenderer";
import type { MarkdownFileLinkResolution } from "./MarkdownRenderer";

interface ChatMarkdownProps {
  children: string;
  className?: string;
  /** Allow raw HTML (secured with sanitization) */
  allowHtml?: boolean;
  resolveFileLink?: (href: string, label: string) => MarkdownFileLinkResolution;
  onFileLinkOpen?: (path: string) => void | Promise<void>;
  onLinkOpen?: (href: string) => void | Promise<void>;
}

export function ChatMarkdown({
  children,
  className,
  allowHtml = false,
  resolveFileLink,
  onFileLinkOpen,
  onLinkOpen,
}: ChatMarkdownProps) {
  return (
    <MarkdownRenderer
      allowHtml={allowHtml}
      className={className}
      proseClassName="markdown-content"
      resolveFileLink={resolveFileLink}
      onFileLinkOpen={onFileLinkOpen}
      onLinkOpen={onLinkOpen}
    >
      {children}
    </MarkdownRenderer>
  );
}
