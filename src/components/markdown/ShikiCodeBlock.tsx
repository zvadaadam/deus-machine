/**
 * ShikiCodeBlock — Progressive syntax highlighting for chat code blocks
 *
 * Renders plain text instantly (CSS-only, matches existing chat styling).
 * After Shiki loads, swaps inner content with highlighted tokens.
 * No layout shift: the outer <code> element stays the same.
 */

import { useEffect, useState } from "react";
import { useTheme } from "@/app/providers";
import { highlightCodeTokens } from "@/shared/lib/syntaxHighlighter";

interface ShikiCodeBlockProps {
  language: string;
  code: string;
  className?: string;
}

export function ShikiCodeBlock({ language, code, className }: ShikiCodeBlockProps) {
  const [tokenHtml, setTokenHtml] = useState<string | null>(null);
  const { actualTheme } = useTheme();
  const shikiTheme = actualTheme === "dark" ? "github-dark" : "github-light";

  useEffect(() => {
    let cancelled = false;

    highlightCodeTokens(code, language, shikiTheme).then((html) => {
      if (!cancelled && html) setTokenHtml(html);
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, shikiTheme]);

  if (tokenHtml) {
    return <code className={className} dangerouslySetInnerHTML={{ __html: tokenHtml }} />;
  }

  // Instant fallback: plain text (exact same DOM as default react-markdown)
  return <code className={className}>{code}</code>;
}
