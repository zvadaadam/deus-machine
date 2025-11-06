/**
 * MultiEdit Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the MultiEdit tool (multiple edits to one file)
 * Shows all edits with before/after diffs
 *
 * BEFORE: 176 LOC
 * AFTER: ~115 LOC
 */

import { useState } from "react";
import { FilePenLine, Copy, Check } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { FilePathDisplay } from "../components/FilePathDisplay";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";

interface Edit {
  old_string: string;
  new_string: string;
}

export function MultiEditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, edits } = toolUse.input;
  const editCount = edits?.length || 0;
  const fileName = file_path.split("/").pop() || file_path;

  // Single clipboard util + per-item key to localize feedback
  const { copy } = useCopyToClipboard();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (key: string, text: string) => {
    copy(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <BaseToolRenderer
      toolName="MultiEdit"
      icon={<FilePenLine className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.MultiEdit)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <>
          <span className={cn(chatTheme.blocks.tool.contentHierarchy.emphasis, "font-mono")}>
            {fileName}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {" "}• {editCount} edit{editCount !== 1 ? "s" : ""}
          </span>
        </>
      )}
      renderContent={() => {
        if (!edits || edits.length === 0) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">No edits provided</div>
          );
        }

        return (
          <div className="space-y-3 px-2 pb-2">
            <div className="text-muted-foreground text-xs">
              {editCount} edit{editCount !== 1 ? "s" : ""} to apply:
            </div>

            {edits.map((edit: Edit, index: number) => (
              <div key={index} className="space-y-1">
                {/* Edit number header */}
                <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                  <span className="bg-muted rounded px-1.5 py-0.5">
                    Edit {index + 1}/{editCount}
                  </span>
                </div>

                {/* Side-by-side diff */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {/* Before (old_string) */}
                  <div className="space-y-1">
                    <div className="bg-destructive/10 border-l-destructive flex items-center justify-between rounded-t border-l-2 px-2 py-1">
                      <span className="text-destructive font-medium">Before</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopy(`old-${index}`, edit.old_string);
                        }}
                        className="hover:bg-destructive/20 rounded p-1 transition-colors"
                        title="Copy before"
                        aria-label="Copy before text"
                      >
                        {copiedKey === `old-${index}` ? (
                          <Check className="text-destructive h-3 w-3" />
                        ) : (
                          <Copy className="text-destructive h-3 w-3" />
                        )}
                      </button>
                    </div>
                    <pre className="bg-destructive/5 border-destructive/20 text-destructive-foreground overflow-x-auto rounded-b border p-2 font-mono break-words whitespace-pre-wrap">
                      {edit.old_string}
                    </pre>
                  </div>

                  {/* After (new_string) */}
                  <div className="space-y-1">
                    <div className="bg-success/10 border-l-success flex items-center justify-between rounded-t border-l-2 px-2 py-1">
                      <span className="text-success font-medium">After</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopy(`new-${index}`, edit.new_string);
                        }}
                        className="hover:bg-success/20 rounded p-1 transition-colors"
                        title="Copy after"
                        aria-label="Copy after text"
                      >
                        {copiedKey === `new-${index}` ? (
                          <Check className="text-success h-3 w-3" />
                        ) : (
                          <Copy className="text-success h-3 w-3" />
                        )}
                      </button>
                    </div>
                    <pre className="bg-success/5 border-success/20 text-success-foreground overflow-x-auto rounded-b border p-2 font-mono break-words whitespace-pre-wrap">
                      {edit.new_string}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
