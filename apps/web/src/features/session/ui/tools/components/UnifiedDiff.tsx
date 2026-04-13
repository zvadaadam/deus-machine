/**
 * UnifiedDiff — Compact diff for chat tool results, powered by @pierre/diffs
 *
 * Takes old/new strings and renders a unified diff with syntax highlighting
 * and word-level change detection. Used by EditToolRenderer and similar blocks.
 */

import { useMemo } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs/react";
import { useDiffOptions } from "@/shared/lib/diffOptions";
import { cn } from "@/shared/lib/utils";

interface UnifiedDiffProps {
  oldString: string;
  newString: string;
  fileName?: string;
  maxHeight?: string;
  className?: string;
}

export function UnifiedDiff({
  oldString,
  newString,
  fileName,
  maxHeight = "400px",
  className,
}: UnifiedDiffProps) {
  const baseDiffOptions = useDiffOptions();
  const displayName = useMemo(() => {
    if (!fileName) return "file";
    const parts = fileName.split("/").filter(Boolean);
    return parts[parts.length - 1] || fileName;
  }, [fileName]);

  const oldFile = useMemo<FileContents>(
    () => ({ name: displayName, contents: oldString, lang: "text" }),
    [displayName, oldString]
  );

  const newFile = useMemo<FileContents>(
    () => ({ name: displayName, contents: newString, lang: "text" }),
    [displayName, newString]
  );

  const diffOptions = useMemo(
    () => ({
      ...baseDiffOptions,
      disableFileHeader: true,
      overflow: "wrap" as const,
    }),
    [baseDiffOptions]
  );

  return (
    <div
      className={cn(
        "border-border/40 w-full max-w-none min-w-0 overflow-hidden rounded-lg border",
        className
      )}
    >
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        options={diffOptions}
        className="diffs-theme block w-full max-w-none min-w-0"
        style={{
          display: "block",
          width: "100%",
          minWidth: "100%",
          maxWidth: "100%",
          maxHeight,
          overflow: "auto",
          overscrollBehavior: "contain",
        }}
      />
    </div>
  );
}
