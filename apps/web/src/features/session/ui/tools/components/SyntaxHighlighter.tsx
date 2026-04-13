/**
 * Syntax Highlighter — Progressive Enhancement
 *
 * Renders plain text instantly, then upgrades with Shiki syntax highlighting.
 * Uses the shared Shiki singleton (src/shared/lib/syntaxHighlighter.ts).
 */

import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/utils";
import { useTheme } from "@/app/providers";
import { highlightCodeTokens, highlightFileLines } from "@/shared/lib/syntaxHighlighter";

interface SyntaxHighlighterProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  className?: string;
}

export function SyntaxHighlighter({
  code,
  language,
  showLineNumbers = false,
  startingLineNumber = 1,
  className,
}: SyntaxHighlighterProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const { actualTheme } = useTheme();
  const shikiTheme = actualTheme === "dark" ? "github-dark" : "github-light";

  useEffect(() => {
    let cancelled = false;

    if (showLineNumbers) {
      highlightFileLines(code, language, shikiTheme).then((lines) => {
        if (cancelled) return;
        // Build line-number table from per-line HTML
        const rows = lines
          .map(
            (lineHtml, i) =>
              `<tr class="hover:bg-[var(--muted)]/30 transition-colors">` +
              `<td class="text-[var(--muted-foreground)] border-r border-[var(--border)]/40 w-12 pr-4 text-right align-top select-none">${startingLineNumber + i}</td>` +
              `<td class="pl-4 align-top"><code class="block whitespace-pre">${lineHtml}</code></td>` +
              `</tr>`
          )
          .join("");
        setHighlightedHtml(`<table class="border-collapse"><tbody>${rows}</tbody></table>`);
      });
    } else {
      highlightCodeTokens(code, language, shikiTheme).then((html) => {
        if (!cancelled && html) setHighlightedHtml(html);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [code, language, shikiTheme, showLineNumbers, startingLineNumber]);

  // Shiki HTML ready — render highlighted output
  if (highlightedHtml) {
    // Line-number mode renders a full table; plain mode renders token spans
    if (showLineNumbers) {
      return (
        <div
          className={cn("font-mono", className)}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      );
    }
    return (
      <div className={cn("font-mono", className)}>
        <code
          className="block whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </div>
    );
  }

  // Instant fallback: plain text (zero delay, matches layout exactly)
  const lines = code.split("\n");

  return (
    <div className={cn("font-mono", className)}>
      {showLineNumbers ? (
        <table className="border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-muted/30 transition-colors">
                <td className="text-muted-foreground border-border/40 w-12 border-r pr-4 text-right align-top select-none">
                  {startingLineNumber + i}
                </td>
                <td className="pl-4 align-top">
                  <code className="block whitespace-pre">{line}</code>
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
