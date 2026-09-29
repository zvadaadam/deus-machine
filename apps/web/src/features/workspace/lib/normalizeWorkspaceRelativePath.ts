export function normalizeWorkspaceRelativePath(path: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/^\/+/, "");

  if (!normalizedPath) return null;

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }

  return normalizedPath;
}

/** Resolve a document link without letting it escape the workspace root. */
export function resolveWorkspaceFileLink(href: string, sourcePath: string): string | null {
  const value = href.trim();
  if (!value || /^(?:#|[a-z][a-z0-9+.-]*:|\/\/|www\.)/iu.test(value)) return null;
  let path: string;
  try {
    path = decodeURIComponent(value.replace(/[?#].*$/u, ""));
  } catch {
    return null;
  }
  if (!path || path.includes("\\") || [...path].some((char) => char.charCodeAt(0) < 32))
    return null;
  const parts = path.startsWith("/") ? [] : sourcePath.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}
