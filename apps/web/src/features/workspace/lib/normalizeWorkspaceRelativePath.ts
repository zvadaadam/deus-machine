export function normalizeWorkspaceRelativePath(path: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/^\/+/, "");

  if (!normalizedPath) return null;

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }

  return normalizedPath;
}
