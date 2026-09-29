import type { MarkdownFileLinkResolution } from "@/components/markdown/MarkdownRenderer";
import { resolveWorkspaceFileLink } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";

/** Resolve only files known to the displayed snapshot, within the Project root. */
export function resolveProjectFileLink(
  href: string,
  sourcePath: string,
  availablePaths: readonly string[]
): MarkdownFileLinkResolution {
  const value = href.trim();
  if (/^(?:#|https?:|mailto:|tel:|\/\/|www\.)/iu.test(value)) return null;
  const unavailable = {
    path: value,
    disabled: true,
    title: "This file is not available in the published version.",
  };
  if (!value || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return unavailable;
  const relative = resolveWorkspaceFileLink(value, sourcePath);
  if (!relative) return unavailable;
  const rootPath = resolveWorkspaceFileLink(value, "");
  // Reports may cite the full published path as well as a sibling artifact.
  const resolved = availablePaths.includes(relative)
    ? relative
    : rootPath && availablePaths.includes(rootPath)
      ? rootPath
      : null;
  return resolved ? { path: resolved, title: `Open ${resolved}` } : unavailable;
}
