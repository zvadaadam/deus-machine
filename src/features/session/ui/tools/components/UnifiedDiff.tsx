/**
 * UnifiedDiff Component - True Unified Diff View
 *
 * Displays changes in VS Code/GitHub style:
 * - Single scrollable view with line numbers
 * - Context lines (unchanged) with neutral background
 * - Deletion lines (red background, "-" prefix)
 * - Addition lines (green background, "+" prefix)
 * - Much more compact than stacked before/after
 *
 * Design Philosophy:
 * - Natural reading flow (top to bottom)
 * - Shows changes in context
 * - Industry-standard format (git diff, GitHub PR)
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useCopyToClipboard } from "@/shared/hooks";
import { diffLines } from "diff";

interface UnifiedDiffProps {
  oldString: string;
  newString: string;
  fileName?: string;
  maxHeight?: string;
}

type DiffLine = {
  type: "context" | "deletion" | "addition";
  content: string;
  oldLineNum?: number; // Line number in old file
  newLineNum?: number; // Line number in new file
};

/**
 * Line diff algorithm using the proven 'diff' package
 * Uses Myers algorithm (same as git) for accurate line-by-line comparison
 */
function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const pieces = diffLines(oldStr, newStr);
  let oldLine = 0;
  let newLine = 0;
  const result: DiffLine[] = [];

  for (const piece of pieces) {
    const lines = piece.value.split("\n");
    // Drop trailing empty item caused by split on trailing newline
    if (lines[lines.length - 1] === "") lines.pop();

    for (const line of lines) {
      if (piece.added) {
        newLine += 1;
        result.push({ type: "addition", content: line, newLineNum: newLine });
      } else if (piece.removed) {
        oldLine += 1;
        result.push({ type: "deletion", content: line, oldLineNum: oldLine });
      } else {
        oldLine += 1;
        newLine += 1;
        result.push({
          type: "context",
          content: line,
          oldLineNum: oldLine,
          newLineNum: newLine,
        });
      }
    }
  }

  return result;
}

export function UnifiedDiff({
  oldString,
  newString,
  fileName,
  maxHeight = "400px",
}: UnifiedDiffProps) {
  const { copy, copied } = useCopyToClipboard();
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

  // Compute diff lines
  const diffLines = computeLineDiff(oldString, newString);

  // Calculate stats
  const additions = diffLines.filter((line) => line.type === "addition").length;
  const deletions = diffLines.filter((line) => line.type === "deletion").length;

  // Generate full diff text for copying
  const generateDiffText = () => {
    return diffLines
      .map((line) => {
        switch (line.type) {
          case "addition":
            return `+${line.content}`;
          case "deletion":
            return `-${line.content}`;
          case "context":
            return ` ${line.content}`;
        }
      })
      .join("\n");
  };

  const handleCopy = () => {
    copy(generateDiffText());
  };

  /**
   * Smart path truncation - matches file changes viewer strategy
   * - Root files: filename.ext
   * - 1 level: src/filename.ext
   * - 2+ levels: src/…/parent/filename.ext
   */
  const formatFilePath = (fullPath: string | undefined) => {
    if (!fullPath) return "";

    const pathParts = fullPath.split("/").filter((part) => part.length > 0);
    const filename = pathParts.pop() || fullPath;

    if (pathParts.length === 0) {
      // Root file - just filename
      return filename;
    } else if (pathParts.length === 1) {
      // One level deep
      return `${pathParts[0]}/${filename}`;
    } else {
      // Multiple levels: firstFolder/…/lastParent/filename
      const firstFolder = pathParts[0];
      const lastParent = pathParts[pathParts.length - 1];
      return `${firstFolder}/…/${lastParent}/${filename}`;
    }
  };

  const displayPath = formatFilePath(fileName);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/40">
      {/* Header - Compact, matches file changes density */}
      <div
        className="border-border flex items-center justify-between border-b bg-muted/30 px-3 py-2"
        onMouseEnter={() => setIsHeaderHovered(true)}
        onMouseLeave={() => setIsHeaderHovered(false)}
      >
        <div className="flex items-center gap-3">
          {displayPath && <span className="font-mono text-xs">{displayPath}</span>}
          {(additions > 0 || deletions > 0) && (
            <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
              {additions > 0 && <span className="text-success">+{additions}</span>}
              {deletions > 0 && <span className="text-destructive">−{deletions}</span>}
            </div>
          )}
        </div>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className={cn(
            "hover:bg-muted flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-all duration-200",
            isHeaderHovered || copied ? "opacity-100" : "opacity-0"
          )}
          title="Copy diff"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Unified diff content */}
      <div
        className="scrollbar-vibrancy overflow-x-hidden overflow-y-auto bg-background font-mono text-xs"
        style={{ maxHeight }}
      >
        {diffLines.map((line, index) => (
          <div
            key={index}
            className={cn("flex items-start", {
              "bg-[var(--diff-deletion-bg)]": line.type === "deletion",
              "bg-[var(--diff-addition-bg)]": line.type === "addition",
            })}
          >
            {/* Old line number */}
            <span
              className={cn(
                "text-muted-foreground w-10 flex-shrink-0 select-none pr-2 text-right",
                {
                  "bg-[var(--diff-deletion-gutter)] text-[var(--diff-deletion-text)]":
                    line.type === "deletion",
                  "bg-transparent": line.type === "addition",
                }
              )}
            >
              {line.oldLineNum || ""}
            </span>

            {/* New line number */}
            <span
              className={cn(
                "text-muted-foreground w-10 flex-shrink-0 select-none pr-2 text-right",
                {
                  "bg-[var(--diff-addition-gutter)] text-[var(--diff-addition-text)]":
                    line.type === "addition",
                  "bg-transparent": line.type === "deletion",
                }
              )}
            >
              {line.newLineNum || ""}
            </span>

            {/* Diff prefix (-, +, or space) */}
            <span
              className={cn("w-5 flex-shrink-0 select-none text-center", {
                "text-destructive font-semibold": line.type === "deletion",
                "text-success font-semibold": line.type === "addition",
                "text-muted-foreground/30": line.type === "context",
              })}
            >
              {line.type === "deletion" ? "−" : line.type === "addition" ? "+" : " "}
            </span>

            {/* Line content */}
            <span
              className={cn("flex-1 whitespace-pre pr-4", {
                "text-[var(--diff-deletion-text)]": line.type === "deletion",
                "text-[var(--diff-addition-text)]": line.type === "addition",
                "text-foreground": line.type === "context",
              })}
            >
              {line.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
