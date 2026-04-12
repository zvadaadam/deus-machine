/**
 * MarkdownRenderer - Fast, secure markdown component for chat
 *
 * Features:
 * - INSTANT rendering (synchronous, no async plugins)
 * - Security: Sanitizes HTML (rehype-sanitize)
 * - Copy button on code blocks
 * - Progressive Shiki syntax highlighting (renders plain first, upgrades after)
 * - Configurable typography
 * - GFM support (tables, task lists, strikethrough)
 *
 * Performance Philosophy:
 * - Uses synchronous Markdown (not MarkdownHooks/Async)
 * - Code blocks render instantly as plain text (CSS-only)
 * - Shiki highlights asynchronously AFTER initial render (no blocking)
 * - Zero layout shift: same <code> element, inner content swapped
 *
 * Usage:
 * ```tsx
 * <MarkdownRenderer>{markdownString}</MarkdownRenderer>
 * <MarkdownRenderer allowHtml>{unsafeMarkdown}</MarkdownRenderer>
 * ```
 */

import { isValidElement, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { cn } from "@/shared/lib/utils";
import { ShikiCodeBlock } from "./ShikiCodeBlock";
import { LazyMermaidDiagram } from "./LazyMermaidDiagram";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";

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
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        // Proper alignment: pre has 8px top + 12px right padding
        // Button positioned at: 12px top (8+4 breathing), 16px right (12+4 breathing)
        "absolute top-3 right-4",
        "rounded p-1.5",
        "text-muted-foreground hover:text-foreground",
        "hover:bg-muted/50",
        "transition-[color,background-color,opacity] duration-200 ease-out",
        "opacity-0 group-hover:opacity-100",
        copied && "text-success"
      )}
      aria-label="Copy code"
    >
      {copied ? (
        // Check icon (copied state)
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        // Copy icon (default state)
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

// Stable component for code blocks — module-level to avoid remounts on parent re-render
function MarkdownCode({ className, children, ...props }: any) {
  const match = /language-([\w-]+)/.exec(className || "");
  const lang = match?.[1];

  if (lang === "mermaid") {
    const chart = String(children).replace(/\n$/, "");
    return <LazyMermaidDiagram chart={chart} />;
  }

  if (lang === "html-preview") {
    const code = String(children).replace(/\n$/, "");
    return <HtmlPreviewBlock code={code} />;
  }

  // Fenced code block — progressive Shiki highlighting
  if (lang) {
    const code = String(children).replace(/\n$/, "");
    return <ShikiCodeBlock language={lang} code={code} className={className} />;
  }

  // Inline code — render as-is
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

// Stable component for pre blocks — useRef called unconditionally to satisfy Rules of Hooks
function MarkdownPre({ children, ...props }: any) {
  const ref = useRef<HTMLPreElement>(null);

  // react-markdown passes <code> as a React element (type=MarkdownCode), not its
  // rendered output. For mermaid/html-preview blocks, MarkdownCode returns a custom
  // component — detect it here via className and skip the <pre> wrapper.
  if (
    isValidElement(children) &&
    /language-(mermaid|html-preview)/.test(String((children.props as any)?.className || ""))
  ) {
    return <>{children}</>;
  }

  return (
    <div className="group relative">
      <pre ref={ref} {...props}>
        {children}
      </pre>
      <CopyButton getText={() => ref.current?.innerText ?? ""} />
    </div>
  );
}

// Stable component map — never recreated, prevents react-markdown from remounting elements
const markdownComponents = {
  code: MarkdownCode,
  pre: MarkdownPre,
};

// Stable plugin arrays — module-level so ReactMarkdown never sees a new reference.
// Same pattern as markdownComponents above: avoids re-processing the pipeline on every render.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS_PLAIN: any[] = [];
const REHYPE_PLUGINS_HTML: any[] = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        pre: [["className"]],
        code: [["className"]],
      },
    },
  ],
];

export function MarkdownRenderer({
  children,
  className = "",
  allowHtml = false,
  proseClassName,
}: MarkdownRendererProps) {
  return (
    <article className={cn(proseClassName, className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={allowHtml ? REHYPE_PLUGINS_HTML : REHYPE_PLUGINS_PLAIN}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </article>
  );
}
