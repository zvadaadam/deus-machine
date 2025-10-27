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

  // Weight-based styling
  const weightStyles = {
    muted: 'text-[13px] leading-[1.5] text-muted-foreground opacity-70 py-1',
    normal: 'text-[15px] leading-relaxed',
    hero: 'text-[16px] leading-[1.7] py-4 mt-3 border-t border-border/20',
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
        // Headings
        'prose-headings:font-semibold prose-headings:tracking-tight',
        'prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg',
        // Links
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
        // Code
        'prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:before:content-none prose-code:after:content-none',
        // Code blocks
        'prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:p-0 prose-pre:m-0',
        // Lists
        'prose-ul:my-2 prose-ol:my-2 prose-li:my-1',
        // Blockquotes
        'prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1',
        // Tables
        'prose-table:border prose-table:border-border',
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
