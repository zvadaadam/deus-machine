/**
 * File Path Display Component
 *
 * Shows file path with icon and proper formatting
 */

import { File, FileCode, FileJson, FileText } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface FilePathDisplayProps {
  path: string;
  className?: string;
}

export function FilePathDisplay({ path, className }: FilePathDisplayProps) {
  // Get file icon based on extension
  const getFileIcon = (filePath: string | undefined) => {
    // Guard against undefined path
    if (!filePath) {
      return <File className="text-muted-foreground h-4 w-4 flex-shrink-0" aria-hidden />;
    }

    // Extract filename and extension, handling edge cases like .gitignore, Dockerfile
    const fileName = filePath.split("/").pop() || "";
    const dotIndex = fileName.lastIndexOf(".");
    const ext = dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";

    const iconProps = { className: "w-4 h-4 flex-shrink-0", "aria-hidden": true };

    switch (ext) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx":
      case "py":
      case "rs":
      case "go":
      case "java":
        return <FileCode {...iconProps} className={cn(iconProps.className, "text-info")} />;

      case "json":
      case "yaml":
      case "yml":
      case "toml":
        return <FileJson {...iconProps} className={cn(iconProps.className, "text-warning")} />;

      case "md":
      case "txt":
      case "log":
        return (
          <FileText {...iconProps} className={cn(iconProps.className, "text-muted-foreground")} />
        );

      default:
        return <File {...iconProps} className={cn(iconProps.className, "text-muted-foreground")} />;
    }
  };

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3 py-1.5",
        "bg-muted/60 border-border/60 border",
        "transition-colors duration-200 ease-out",
        className
      )}
    >
      {getFileIcon(path)}
      {/* RTL trick: When path overflows, truncation shows the filename (end)
          instead of the root directory (start). Much more useful at a glance. */}
      <span
        className="text-foreground/80 block min-w-0 truncate font-mono text-xs font-medium"
        dir="rtl"
        title={path}
      >
        {path}
      </span>
    </div>
  );
}
