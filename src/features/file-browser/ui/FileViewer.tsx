import { useState, useMemo } from "react";
import { Copy, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { highlightFileLines } from "@/shared/lib/syntaxHighlighter";
import { detectLanguageFromPath } from "@/features/session/ui/tools/utils/detectLanguage";
import { useTheme } from "@/app/providers";
import { useFileContent } from "../api/useFileContent";
import { useQuery } from "@tanstack/react-query";

interface FileViewerProps {
  filePath: string;
}

/**
 * FileViewer - Display full file content with syntax highlighting
 *
 * Reads directly from the working tree (disk) using Tauri FS plugin.
 * Shows current file state including unsaved/uncommitted changes.
 *
 * Features:
 * - Syntax highlighting via Shiki
 * - Line numbers
 * - Copy button
 * - Loading/error states
 */
export function FileViewer({ filePath }: FileViewerProps) {
  const [copied, setCopied] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

  // Use app theme provider for syntax highlighting
  const { actualTheme } = useTheme();
  const shikiTheme = useMemo(
    () => (actualTheme === "dark" ? "github-dark" : "github-light"),
    [actualTheme]
  );

  /**
   * Extract filename and path context from full file path
   */
  const pathParts = filePath.split("/").filter((part) => part.length > 0);
  const filename = pathParts.pop() || filePath;
  const pathContext = pathParts.length > 0 ? pathParts.join("/") + "/" : "";

  /**
   * Detect programming language from file extension
   */
  const language = filePath ? detectLanguageFromPath(filePath) : "text";

  // Fetch file content from disk
  const { data: content, isLoading: isContentLoading, error } = useFileContent(filePath);

  // Highlight entire file at once (single Shiki call instead of per-line)
  const { data: highlightedLines, isLoading: isHighlighting } = useQuery({
    queryKey: ["file-highlight", filePath, content, shikiTheme],
    queryFn: () => highlightFileLines(content!, language, shikiTheme),
    enabled: !!content,
    staleTime: Infinity, // Don't refetch highlighting for same content
  });

  const lines = content?.split("\n") || [];
  const isLoading = isContentLoading || isHighlighting;

  /**
   * Copy file content to clipboard
   */
  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy file:", err);
    }
  };

  /**
   * Render a single line with line number
   */
  const renderLine = (highlightedCode: string, lineNum: number) => {
    return (
      <div
        key={lineNum}
        className="relative flex items-stretch font-mono text-[13px] leading-normal tracking-normal"
      >
        {/* Line number gutter */}
        <span className="w-12 flex-shrink-0 bg-[var(--diff-line-number-bg)] px-3 text-right text-[var(--diff-line-number)] select-none">
          {lineNum}
        </span>
        {/* Code content */}
        <span
          className="text-foreground/90 flex-1 py-px pr-4 pl-4 whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </div>
    );
  };

  return (
    <div className="bg-background flex h-full flex-col overflow-hidden">
      {/* Header - Fixed at top */}
      <div
        className="border-border flex-shrink-0 border-b"
        onMouseEnter={() => setIsHeaderHovered(true)}
        onMouseLeave={() => setIsHeaderHovered(false)}
      >
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          {/* Left: File path hierarchy */}
          <div className="min-w-0 flex-1 text-xs">
            {pathContext && (
              <span className="text-muted-foreground/50 font-normal">{pathContext}</span>
            )}
            <span className="text-foreground font-medium">{filename || "Untitled"}</span>
          </div>

          {/* Right: Line count + Copy button */}
          <div className="flex items-center gap-4">
            {/* Line count */}
            {!isLoading && !error && lines.length > 0 && (
              <span className="text-2xs text-muted-foreground/50 font-mono tabular-nums">
                {lines.length} lines
              </span>
            )}

            {/* Copy button: appears on hover */}
            {!isLoading && !error && content && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                className={cn(
                  "h-6 w-6 transition-opacity duration-200",
                  isHeaderHovered || copied ? "opacity-100" : "opacity-0"
                )}
                title="Copy file content"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* File content - Scrollable */}
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth motion-reduce:scroll-auto">
        {isLoading ? (
          <div className="text-muted-foreground/60 flex h-64 items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Loading file...</span>
            </div>
          </div>
        ) : error ? (
          <div className="text-muted-foreground/60 flex h-64 items-center justify-center">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <p className="text-sm">
                {error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : "Failed to load file"}
              </p>
            </div>
          </div>
        ) : lines.length === 0 ? (
          <div className="text-muted-foreground/60 flex h-64 items-center justify-center">
            <p className="text-sm">Empty file</p>
          </div>
        ) : (
          <div>{highlightedLines?.map((html, idx) => renderLine(html, idx + 1))}</div>
        )}
      </div>
    </div>
  );
}
