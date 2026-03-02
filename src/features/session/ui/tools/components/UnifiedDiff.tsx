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

interface UnifiedDiffProps {
  oldString: string;
  newString: string;
  fileName?: string;
  maxHeight?: string;
}

export function UnifiedDiff({
  oldString,
  newString,
  fileName,
  maxHeight = "400px",
}: UnifiedDiffProps) {
  const baseDiffOptions = useDiffOptions();
  const displayName = useMemo(() => {
    if (!fileName) return "file";
    const parts = fileName.split("/").filter(Boolean);
    return parts[parts.length - 1] || fileName;
  }, [fileName]);

  const oldFile = useMemo<FileContents>(
    () => ({ name: displayName, contents: oldString }),
    [displayName, oldString]
  );

  const newFile = useMemo<FileContents>(
    () => ({ name: displayName, contents: newString }),
    [displayName, newString]
  );

  const diffOptions = useMemo(
    () => ({
      ...baseDiffOptions,
      disableFileHeader: true,
    }),
    [baseDiffOptions]
  );

  return (
    <div className="border-border/40 overflow-hidden rounded-lg border">
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        options={diffOptions}
        className="diffs-theme"
        style={{ maxHeight, overflow: "auto", overscrollBehavior: "contain" }}
      />
    </div>
  );
}
