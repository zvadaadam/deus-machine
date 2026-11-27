import { useState, useMemo, type ReactNode } from "react";
import { Loader2, X, Code, BookOpen, FolderOpen, ArrowUpRight } from "lucide-react";
import { CopyIcon } from "@/components/ui/copy-icon";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { highlightFileLines } from "@/shared/lib/syntaxHighlighter";
import { detectLanguageFromPath } from "@/features/session/ui/tools/utils/detectLanguage";
import { MarkdownRenderer } from "@/components/markdown/MarkdownRenderer";
import { WORKSPACE_FILES_GONE } from "@shared/types/files";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { useTheme } from "@/app/providers";
import { useFileContent } from "../api/useFileContent";
import { PierreFileIcon } from "../lib/pierreIcons";
import { useQuery } from "@tanstack/react-query";

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

interface FileViewerProps {
  workspaceId: string;
  workspaceName?: string;
  header?: (hasCheckout: boolean) => ReactNode;
  /** Relative path within the workspace */
  filePath: string;
  /** Optional close handler — renders a close button in the header */
  onClose?: () => void;
  /** Reveal this file inside the Files explorer tree tab */
  onRevealInFiles?: () => void;
  /** Open this file in its own dedicated workspace tab */
  onOpenInNewTab?: () => void;
}

/**
 * FileViewer - Display full file content with syntax highlighting
 *
 * Reads from the working tree via the runtime socket.
 * Shows current file state including unsaved/uncommitted changes.
 *
 * Features:
 * - Syntax highlighting via Shiki
 * - Line numbers
 * - Copy button
 * - Loading/error states
 */
export function FileViewer({
  workspaceId,
  workspaceName,
  header,
  filePath,
  onClose,
  onRevealInFiles,
  onOpenInNewTab,
}: FileViewerProps) {
  const { copy, copied } = useCopyToClipboard();
  const isMarkdown = isMarkdownFile(filePath);
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

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

  // Fetch file content via the runtime socket
  const {
    data: content,
    isLoading: isContentLoading,
    isFetching,
    error,
  } = useFileContent(workspaceId, filePath);

  // Highlight entire file at once (single Shiki call instead of per-line)
  const { data: highlightedLines, isLoading: isHighlighting } = useQuery({
    queryKey: ["file-highlight", filePath, content, shikiTheme],
    queryFn: () => highlightFileLines(content!, language, shikiTheme),
    enabled: !!content,
    staleTime: Infinity, // Don't refetch highlighting for same content
  });

  const failure = error && getErrorMessage(error);
  const filesGone = failure === WORKSPACE_FILES_GONE;
  const isEmpty = content != null && content.length === 0;
  const lines = content?.split("\n") || [];
  const isLoading = isContentLoading || isHighlighting;

  /**
   * Render a single line with line number
   */
  const renderLine = (highlightedCode: string, lineNum: number) => {
    return (
      <div key={lineNum} className="relative flex items-stretch font-mono text-[11px] leading-4">
        {/* Line number gutter */}
        <span className="text-muted-foreground w-12 flex-shrink-0 px-3 text-right select-none">
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
      {header?.(!isFetching && !filesGone)}
      {/* Header - Fixed at top, h-10 matches DiffViewer */}
      <div className="border-border-subtle flex-shrink-0 border-b">
        <div className="flex h-10 items-center justify-between gap-4 px-4">
          {/* Left: File path hierarchy */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
            <PierreFileIcon
              fileName={filename || "file"}
              size={13}
              className="text-muted-foreground/70 flex-shrink-0"
            />
            {pathContext && (
              <span className="text-muted-foreground/50 min-w-0 truncate font-normal">
                {pathContext}
              </span>
            )}
            <span className="text-foreground shrink-0 font-medium">{filename || "Untitled"}</span>
          </div>

          {/* Right: Toggle + Copy + Tab/Tree + Close buttons */}
          <div className="flex items-center gap-1">
            {/* Markdown preview/raw toggle */}
            {isMarkdown && !isLoading && !error && content && (
              <button
                type="button"
                onClick={() => setShowRawMarkdown((v) => !v)}
                className="control-interaction text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-lg"
                title={showRawMarkdown ? "Show preview" : "Show raw markdown"}
                aria-label={showRawMarkdown ? "Show preview" : "Show raw markdown"}
              >
                {showRawMarkdown ? <BookOpen className="h-3 w-3" /> : <Code className="h-3 w-3" />}
              </button>
            )}

            {/* Reveal in Files explorer */}
            {onRevealInFiles && (
              <button
                type="button"
                onClick={onRevealInFiles}
                className="control-interaction text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-lg"
                title="Show in Files"
                aria-label="Show in Files"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            )}

            {/* Open in dedicated tab */}
            {onOpenInNewTab && (
              <button
                type="button"
                onClick={onOpenInNewTab}
                className="control-interaction text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-lg"
                title="Open in new tab"
                aria-label="Open in new tab"
              >
                <ArrowUpRight className="h-3 w-3" />
              </button>
            )}

            {/* Copy button */}
            {!isLoading && !error && content && (
              <button
                type="button"
                onClick={() => void copy(content)}
                className="control-interaction text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-lg"
                title={copied ? "Copied" : "Copy file content"}
                aria-label={copied ? "Copied" : "Copy file content"}
              >
                <CopyIcon copied={copied} className="size-3" />
              </button>
            )}

            {/* Close button */}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="control-interaction text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-lg"
                title="Close file preview"
                aria-label="Close file preview"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* File content - Scrollable */}
      <div className="relative min-h-0 flex-1 overflow-auto scroll-smooth motion-reduce:scroll-auto">
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
                {filesGone && workspaceName
                  ? `${workspaceName}'s files are gone.`
                  : workspaceName && failure === "File not found"
                    ? `This file isn't in ${workspaceName} any more.`
                    : failure}
              </p>
            </div>
          </div>
        ) : isEmpty || lines.length === 0 ? (
          <div className="text-muted-foreground/60 flex h-64 items-center justify-center">
            <p className="text-sm">Empty file</p>
          </div>
        ) : isMarkdown && !showRawMarkdown ? (
          <div
            className={cn(
              "markdown-content px-6 py-4",
              header &&
                "mx-auto max-w-[96ch] [&_table]:block [&_table]:overflow-x-auto [&_table]:[word-break:normal] [&_th]:whitespace-nowrap"
            )}
          >
            <MarkdownRenderer allowHtml>{content!}</MarkdownRenderer>
          </div>
        ) : (
          <div className="w-max min-w-full">
            {highlightedLines?.map((html, idx) => renderLine(html, idx + 1))}
          </div>
        )}
      </div>
    </div>
  );
}
