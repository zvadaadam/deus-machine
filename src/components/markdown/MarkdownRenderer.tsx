/**
 * MarkdownRenderer - Secure, reusable markdown component
 *
 * Features:
 * - Shiki syntax highlighting (dual light/dark themes)
 * - Security: Sanitizes HTML (rehype-sanitize)
 * - Copy button on code blocks
 * - Configurable typography
 * - GFM support (tables, task lists, strikethrough)
 *
 * Implementation:
 * Uses MarkdownHooks (not MarkdownAsync) because:
 * - MarkdownHooks: Client-side async plugins via React hooks (useEffect/useState)
 * - MarkdownAsync: Server-side async via async/await (returns Promise<ReactElement>)
 * Since this is a Tauri/Vite client app, MarkdownHooks is correct.
 *
 * Usage:
 * ```tsx
 * <MarkdownRenderer>{markdownString}</MarkdownRenderer>
 * <MarkdownRenderer allowHtml sanitize>{unsafeMarkdown}</MarkdownRenderer>
 * ```
 */

import { useRef, useState } from 'react';
import { MarkdownHooks } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeShiki from '@shikijs/rehype';
import {
  transformerNotationDiff,
  transformerNotationHighlight,
} from '@shikijs/transformers';
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
 * Copy button for code blocks
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
        'absolute top-2 right-2 px-2 py-1 rounded text-xs',
        'bg-background/80 border border-border',
        'hover:bg-background transition-colors duration-200',
        'opacity-0 group-hover:opacity-100'
      )}
      aria-label="Copy code"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

export function MarkdownRenderer({
  children,
  className = '',
  allowHtml = false,
  proseClassName,
}: MarkdownRendererProps) {
  // Build rehype pipeline
  const rehypePlugins: any[] = [
    // Shiki syntax highlighting with dual themes
    [
      rehypeShiki,
      {
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
        transformers: [
          transformerNotationDiff(),      // [!code ++] / [!code --]
          transformerNotationHighlight(), // [!code highlight]
        ],
      },
    ],
  ];

  // Security: Only allow raw HTML if explicitly enabled, and sanitize it
  if (allowHtml) {
    rehypePlugins.unshift(rehypeRaw);
    rehypePlugins.push([
      rehypeSanitize,
      {
        ...defaultSchema,
        // Allow Shiki's styling on code blocks
        attributes: {
          ...defaultSchema.attributes,
          pre: [['className'], ['style']],
          code: [['className']],
          span: [['style'], ['className']],
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

  // Use MarkdownHooks for client-side async plugins (Shiki)
  // Fallback prevents flash during async processing
  return (
    <article className={cn(proseClassName, className)}>
      <MarkdownHooks
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        fallback={
          <div className="text-muted-foreground/60 text-sm animate-pulse">
            {children}
          </div>
        }
      >
        {children}
      </MarkdownHooks>
    </article>
  );
}
