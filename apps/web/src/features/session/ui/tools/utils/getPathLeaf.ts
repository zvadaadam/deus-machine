export function getPathLeaf(path: string | null | undefined, fallback = "unknown") {
  if (!path) return fallback;

  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path || fallback;
}
