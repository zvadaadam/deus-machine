/**
 * Code Block Component
 *
 * Displays code with optional syntax highlighting and copy button
 */

import { CopyButton } from './CopyButton';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  maxHeight?: string;
  className?: string;
}

export function CodeBlock({
  code,
  language = 'text',
  showLineNumbers = false,
  maxHeight = '400px',
  className
}: CodeBlockProps) {
  return (
    <div className={cn(chatTheme.blocks.code.container, className)}>
      {/* Copy button (appears on hover) */}
      <div className={chatTheme.blocks.code.copyButton}>
        <CopyButton text={code} label="Copy" />
      </div>

      {/* Code content with syntax highlighting */}
      <div
        className={cn(
          chatTheme.blocks.code.pre,
          'scrollbar-vibrancy'
        )}
        style={{ maxHeight }}
      >
        <SyntaxHighlighter
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
        />
      </div>
    </div>
  );
}
