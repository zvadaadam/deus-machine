interface RoutableEnvironment {
  id: string;
  name: string;
  repo: string | null;
}

/** `owner/name` for a repository URL; the URL itself when it doesn't parse. */
export function repositorySlug(repo: string | null): string | null {
  if (!repo) return null;
  try {
    const url = new URL(repo);
    return url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || url.host;
  } catch {
    return repo;
  }
}

/**
 * How a routing rule's target reads: its repository, unless another shared
 * environment has the same one or it has none. Then the environment's name
 * tells them apart, as the router's options do.
 */
export function routingTarget(
  environment: RoutableEnvironment,
  shared: readonly RoutableEnvironment[]
): { label: string; detail: string | null } {
  const slug = repositorySlug(environment.repo);
  const unique = slug && shared.filter((other) => repositorySlug(other.repo) === slug).length === 1;
  return unique ? { label: slug, detail: null } : { label: environment.name, detail: slug };
}
