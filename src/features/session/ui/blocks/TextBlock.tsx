/**
 * Text Block
 *
 * Renders text content blocks from messages with semantic weight.
 * - Assistant messages: Rendered as markdown (Claude uses markdown)
 * - User messages: Rendered as plain text (user input)
 *
 * Weight variants:
 * - 'muted': Transitional text between actions (13px, opacity 0.7)
 * - 'normal': Regular text (15px, normal opacity)
 * - 'hero': Final summary text (16px, prominent, with top border)
 *
 * Design reference: CHAT_REDESIGN.md - Text Block Visual Weight
 */

import type { TextBlock as TextBlockType, MessageRole } from '@/shared/types';
import { chatTheme } from '../theme';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/shared/lib/utils';
import { CopyButton } from '../tools/components/CopyButton';

export type TextWeight = 'muted' | 'normal' | 'hero';

interface TextBlockProps {
  block: TextBlockType | string;
  role?: MessageRole;
  weight?: TextWeight;
}

/**
 * Custom Pre component with copy button
 * Extracts code text and shows copy button on hover
 */
function PreWithCopy({ children, ...props }: any) {
  // Extract code text from children
  const getCodeText = (node: any): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(getCodeText).join('');
    if (node?.props?.children) return getCodeText(node.props.children);
    return '';
  };

  const codeText = getCodeText(children);

  return (
    <div className={chatTheme.blocks.code.container}>
      {/* Copy button - visible on hover */}
      <div className={chatTheme.blocks.code.copyButton}>
        <CopyButton text={codeText} label="Copy" size="sm" />
      </div>

      {/* Code content */}
      <pre {...props} className={cn(props.className, 'p-3 overflow-x-auto')}>
        {children}
      </pre>
    </div>
  );
}

export function TextBlock({ block, role = 'assistant', weight = 'normal' }: TextBlockProps) {
  // Handle both TextBlock objects and plain strings
  const text = typeof block === 'string' ? block : block.text;

  if (!text || text.trim() === '') {
    return null;
  }

  // Weight-based styling - compact for IDE density
  const weightStyles = {
    muted: 'text-[13px] leading-[1.5] text-muted-foreground opacity-70 py-1',
    normal: 'text-[14px] leading-[1.6]',
    hero: 'text-[15px] leading-[1.65] py-3 mt-2 border-t border-border/20',
  };

  // User messages: plain text (preserve newlines)
  if (role === 'user') {
    return (
      <div className={chatTheme.blocks.text.container}>
        <p className={cn(chatTheme.blocks.text.content, 'whitespace-pre-wrap', weightStyles[weight])}>
          {text}
        </p>
      </div>
    );
  }

  // Assistant messages: markdown
  return (
    <div
      className={cn(
        chatTheme.blocks.text.container,
        chatTheme.blocks.text.content,
        weightStyles[weight],
        'prose prose-sm dark:prose-invert max-w-full min-w-0 overflow-x-auto',

        // Paragraphs - breathing room between blocks
        'prose-p:my-3 prose-p:leading-[1.6]',

        // Headings - STRONG hierarchy with color + weight
        'prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-foreground',
        'prose-h1:text-[20px] prose-h1:mt-6 prose-h1:mb-3',
        'prose-h2:text-[18px] prose-h2:mt-5 prose-h2:mb-2',
        'prose-h3:text-[16px] prose-h3:mt-4 prose-h3:mb-2',

        // Links
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',

        // Inline code
        'prose-code:bg-muted/70 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[13px] prose-code:font-mono prose-code:font-medium prose-code:before:content-none prose-code:after:content-none',

        // Code blocks
        'prose-pre:bg-muted/70 prose-pre:border prose-pre:border-border/60 prose-pre:rounded-lg prose-pre:p-0 prose-pre:my-4',

        // Lists - VISIBLE bullets and clear hierarchy
        'prose-ul:my-3 prose-ul:list-disc prose-ul:pl-5',
        'prose-ol:my-3 prose-ol:list-decimal prose-ol:pl-5',
        'prose-li:my-1.5 prose-li:leading-[1.6]',
        'marker:text-foreground/60',

        // Strong/Bold - make it ACTUALLY BOLD
        'prose-strong:font-bold prose-strong:text-foreground',

        // Blockquotes
        'prose-blockquote:border-l-2 prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:my-3',

        // Tables
        'prose-table:border prose-table:border-border prose-table:my-4',
        'prose-th:bg-muted prose-th:border prose-th:border-border prose-th:p-2',
        'prose-td:border prose-td:border-border prose-td:p-2'
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: PreWithCopy,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
