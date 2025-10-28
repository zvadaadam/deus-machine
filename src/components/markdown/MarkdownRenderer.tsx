/**
 * MarkdownRenderer - Fast, secure markdown component for chat
 *
 * Features:
 * - INSTANT rendering (synchronous, no async plugins)
 * - Security: Sanitizes HTML (rehype-sanitize)
 * - Copy button on code blocks
 * - Configurable typography
 * - GFM support (tables, task lists, strikethrough)
 *
 * Performance Philosophy:
 * - Uses synchronous Markdown (not MarkdownHooks/Async)
 * - NO syntax highlighting for chat (Shiki is slow, adds 200ms+ delay)
 * - Basic code styling via CSS (instant, good enough for chat)
 * - Save Shiki for file viewer where syntax highlighting matters
 *
 * Usage:
 * ```tsx
 * <MarkdownRenderer>{markdownString}</MarkdownRenderer>
 * <MarkdownRenderer allowHtml>{unsafeMarkdown}</MarkdownRenderer>
 * ```
 */

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { cn } from '@/shared/lib/utils';

interface MarkdownRendererProps {
  children: string;
  className?: string;
  /** Allow raw HTML (with sanitization) - use with caution */
  allowHtml?: boolean;
  /** Custom prose classes (default: chat-optimized) */
  proseClassName?: string;
}

/**
 * Copy button for code blocks - Icon-only, subtle, Jony Ive style
 */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = getText();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'absolute top-2 right-2',
        'p-1.5 rounded',
        'text-muted-foreground hover:text-foreground',
        'hover:bg-muted/50',
        'transition-all duration-200 ease-out',
        'opacity-0 group-hover:opacity-100',
        copied && 'text-success'
      )}
      aria-label="Copy code"
    >
      {copied ? (
        // Check icon (copied state)
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        // Copy icon (default state)
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

export function MarkdownRenderer({
  children,
  className = '',
  allowHtml = false,
  proseClassName,
}: MarkdownRendererProps) {
  // Build rehype pipeline - NO ASYNC PLUGINS for performance
  const rehypePlugins: any[] = [];

  // Security: Only allow raw HTML if explicitly enabled, and sanitize it
  if (allowHtml) {
    rehypePlugins.push(rehypeRaw);
    rehypePlugins.push([
      rehypeSanitize,
      {
        ...defaultSchema,
        // Allow basic code styling
        attributes: {
          ...defaultSchema.attributes,
          pre: [['className']],
          code: [['className']],
        },
      },
    ]);
  }

  // Custom components
  const components = {
    // Wrap code blocks with copy button
    pre({ children, ...props }: any) {
      const ref = useRef<HTMLPreElement>(null);
      return (
        <div className="relative group">
          <pre ref={ref} {...props}>
            {children}
          </pre>
          <CopyButton getText={() => ref.current?.innerText ?? ''} />
        </div>
      );
    },
  };

  // Use synchronous Markdown - INSTANT rendering (no async delay)
  return (
    <article className={cn(proseClassName, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </article>
  );
}
