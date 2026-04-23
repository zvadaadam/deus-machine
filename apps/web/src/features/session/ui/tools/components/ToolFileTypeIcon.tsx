import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import { cn } from "@/shared/lib/utils";
import { TOOL_ICON_MUTED_CLS } from "../toolColors";

interface ToolFileTypeIconProps {
  path: string;
  className?: string;
}

/**
 * Pierre VS Code file-type icon sized + muted for the tool-card header slot.
 * Replaces the generic Lucide FileText/Plus/Edit icons on Read/Write/Edit/MultiEdit
 * cards with a per-extension glyph, matching the FileTree + ChangesFilesPanel
 * visual language. Pierre's resolver falls back to a generic file glyph for
 * paths with no recognised extension.
 */
export function ToolFileTypeIcon({ path, className }: ToolFileTypeIconProps) {
  const fileName = path.slice(path.lastIndexOf("/") + 1) || "file";
  return (
    <PierreFileIcon
      fileName={fileName}
      size={14}
      className={cn("flex-shrink-0", TOOL_ICON_MUTED_CLS, className)}
    />
  );
}
