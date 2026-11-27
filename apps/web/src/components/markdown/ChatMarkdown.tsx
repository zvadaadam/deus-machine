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
type ChatMarkdownProps = Omit<React.ComponentProps<typeof MarkdownRenderer>, "proseClassName">;

export function ChatMarkdown(props: ChatMarkdownProps) {
  return <MarkdownRenderer {...props} proseClassName="markdown-content" />;
}
