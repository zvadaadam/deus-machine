import { httpsOrigin, normalizeRepoRef } from "@shared/git-origin";

interface RoutableEnvironment {
  id: string;
  name: string;
  repo: string | null;
}

/** `owner/name` for a repository URL, ssh or https; the URL itself when it doesn't parse. */
export function repositorySlug(repo: string | null): string | null {
  if (!repo) return null;
  try {
    const url = new URL(httpsOrigin(repo));
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
  // One repository however its remote is written: ssh or https, any case, with or without .git.
  const identity = (repo: string | null) => (repo ? normalizeRepoRef(httpsOrigin(repo)) : null);
  const unique =
    slug &&
    shared.filter((other) => identity(other.repo) === identity(environment.repo)).length === 1;
  return unique ? { label: slug, detail: null } : { label: environment.name, detail: slug };
}
