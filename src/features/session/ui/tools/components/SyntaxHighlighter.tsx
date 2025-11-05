/**
 * Simple Syntax Highlighter
 *
 * Basic syntax highlighting without external dependencies.
 * Can be replaced with Prism.js or Shiki later for better highlighting.
 */

import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

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
  className,
}: SyntaxHighlighterProps) {
  const lines = code.split("\n");

  // Simple keyword highlighting for common languages
  const highlightLine = (line: string, lang: string): ReactNode => {
    // For now, return plain text. Easy to enhance later.
    // This keeps the component ready for Prism.js integration.
    return line;
  };

  return (
    <div className={cn("font-mono text-sm", className)}>
      {showLineNumbers ? (
        <table className="border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-muted/30 transition-colors">
                <td className="text-muted-foreground border-border/40 w-12 border-r pr-4 text-right align-top select-none">
                  {i + 1}
                </td>
                <td className="pl-4 align-top">
                  <code className="block whitespace-pre">{highlightLine(line, language)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <code className="block whitespace-pre">{code}</code>
      )}
    </div>
  );
}
