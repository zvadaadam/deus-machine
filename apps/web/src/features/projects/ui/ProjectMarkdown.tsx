import { useMemo } from "react";
import { MarkdownRenderer } from "@/components/markdown/MarkdownRenderer";
import { projectMarkdownLinks } from "../lib/projectMarkdownLinks";

export function ProjectMarkdown({
  children,
  sourcePath,
  availablePaths,
  onOpenFile,
  className,
}: {
  children: string;
  sourcePath: string;
  availablePaths: readonly string[];
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  const links = useMemo(
    () => projectMarkdownLinks(sourcePath, availablePaths, onOpenFile),
    [sourcePath, availablePaths, onOpenFile]
  );
  return (
    <MarkdownRenderer className={className} proseClassName="markdown-content" {...links}>
      {children}
    </MarkdownRenderer>
  );
}
