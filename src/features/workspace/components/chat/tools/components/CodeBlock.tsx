/**
 * Code Block Component
 *
 * Displays code with optional syntax highlighting and copy button
 */

import { CopyButton } from './CopyButton';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';

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
  // For now, simple pre/code. We can add Prism.js later
  const lines = code.split('\n');

  return (
    <div className={cn(chatTheme.blocks.code.container, className)}>
      {/* Copy button (appears on hover) */}
      <div className={chatTheme.blocks.code.copyButton}>
        <CopyButton text={code} label="Copy" />
      </div>

      {/* Code content */}
      <pre
        className={cn(
          chatTheme.blocks.code.pre,
          'scrollbar-vibrancy'
        )}
        style={{ maxHeight }}
      >
        <code className="font-mono text-sm">
          {showLineNumbers ? (
            <table className="w-full">
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className={cn(chatTheme.blocks.code.lineNumbers, 'w-8 text-right')}>
                      {i + 1}
                    </td>
                    <td className="pl-4">{line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            code
          )}
        </code>
      </pre>
    </div>
  );
}
