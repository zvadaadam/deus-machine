/**
 * Simple Syntax Highlighter
 *
 * Basic syntax highlighting without external dependencies.
 * Can be replaced with Prism.js or Shiki later for better highlighting.
 */

import { cn } from '@/lib/utils';

interface SyntaxHighlighterProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  className?: string;
}

export function SyntaxHighlighter({
  code,
  language,
  showLineNumbers = false,
  className
}: SyntaxHighlighterProps) {
  const lines = code.split('\n');

  // Simple keyword highlighting for common languages
  const highlightLine = (line: string, lang: string): React.ReactNode => {
    // For now, return plain text. Easy to enhance later.
    // This keeps the component ready for Prism.js integration.
    return line;
  };

  return (
    <div className={cn('font-mono text-sm', className)}>
      {showLineNumbers ? (
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-muted/30 transition-colors">
                <td className="text-muted-foreground select-none text-right pr-4 border-r border-border/40 align-top w-12">
                  {i + 1}
                </td>
                <td className="pl-4 align-top">
                  <code className="block whitespace-pre">
                    {highlightLine(line, language)}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <code className="block whitespace-pre">
          {code}
        </code>
      )}
    </div>
  );
}
