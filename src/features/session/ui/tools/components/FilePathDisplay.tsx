/**
 * File Path Display Component
 *
 * Shows file path with icon and proper formatting
 */

import { match, P } from "ts-pattern";
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

    return match(ext)
      .with(P.union("ts", "tsx", "js", "jsx", "py", "rs", "go", "java"), () => (
        <FileCode {...iconProps} className={cn(iconProps.className, "text-info")} />
      ))
      .with(P.union("json", "yaml", "yml", "toml"), () => (
        <FileJson {...iconProps} className={cn(iconProps.className, "text-warning")} />
      ))
      .with(P.union("md", "txt", "log"), () => (
        <FileText {...iconProps} className={cn(iconProps.className, "text-muted-foreground")} />
      ))
      .otherwise(() => (
        <File {...iconProps} className={cn(iconProps.className, "text-muted-foreground")} />
      ));
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
