import { httpsOrigin } from "@shared/git-origin";

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
  // Judged on what the label shows: one repository written two ways (ssh or
  // https, any case) or two hosts with the same path would read the same.
  const shown = (repo: string | null) => repositorySlug(repo)?.toLowerCase() ?? null;
  const unique =
    slug && shared.filter((other) => shown(other.repo) === shown(environment.repo)).length === 1;
  return unique ? { label: slug, detail: null } : { label: environment.name, detail: slug };
}
