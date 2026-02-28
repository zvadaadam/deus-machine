/**
 * Code Block Component
 *
 * Displays code with optional syntax highlighting and copy button
 */

import { CopyButton } from "./CopyButton";
import { SyntaxHighlighter } from "./SyntaxHighlighter";

import { cn } from "@/shared/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  maxHeight?: string;
  className?: string;
}

export function CodeBlock({
  code,
  language = "text",
  showLineNumbers = false,
  maxHeight = "400px",
  className,
}: CodeBlockProps) {
  return (
    <div
      className={cn("group border-border/60 relative overflow-hidden rounded-lg border", className)}
    >
      {/* Copy button (appears on hover) */}
      <div className="absolute top-2 right-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <CopyButton text={code} label="Copy" />
      </div>

      {/* Code content with syntax highlighting */}
      <div
        className={cn(
          "bg-muted/70 m-0 overflow-x-auto rounded-lg p-4 font-mono text-sm",
          "scrollbar-vibrancy"
        )}
        style={{ maxHeight }}
      >
        <SyntaxHighlighter code={code} language={language} showLineNumbers={showLineNumbers} />
      </div>
    </div>
  );
}
