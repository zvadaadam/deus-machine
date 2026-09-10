import { githubRepoSlug, httpsOrigin, normalizeRepoRef } from "@shared/git-origin";
import type { Repository } from "@shared/types/repository";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";

export interface EnvironmentRepository {
  key: string;
  name: string;
  repo: string | null;
  local?: Repository;
  environment?: CloudEnvironmentSettings["environments"][number];
}
const identity = (repo: string) => normalizeRepoRef(httpsOrigin(repo));
export const repositoryLabel = (repo: string) =>
  githubRepoSlug(repo) ?? repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");

/** Join local repositories, GitHub access and saved recipes by their remote. */
export function environmentRepositories(
  local: Repository[],
  accessible: string[],
  environments: CloudEnvironmentSettings["environments"]
): EnvironmentRepository[] {
  const rows = new Map<string, EnvironmentRepository>();
  for (const repository of local) {
    const repo = repository.git_origin_url ? httpsOrigin(repository.git_origin_url) : null;
    const remoteKey = repo ? identity(repo) : repository.id;
    const key = rows.has(remoteKey) ? repository.id : remoteKey;
    rows.set(key, {
      key,
      repo,
      name: repo ? repositoryLabel(repo) : repository.name,
      local: repository,
    });
  }
  for (const name of accessible) {
    const repo = `https://github.com/${name}`;
    const key = identity(repo);
    if (!rows.has(key)) rows.set(key, { key, repo, name });
  }
  // Keep personal recipes individually editable when a shared recipe exists for the same repo.
  for (const env of [...environments].sort((a, b) => a.ownerType.localeCompare(b.ownerType))) {
    const key = env.repo && env.isRepositoryDefault ? identity(env.repo) : env.id;
    const existing = rows.get(key);
    const rowKey = existing?.environment ? env.id : key;
    rows.set(rowKey, {
      ...existing,
      key: rowKey,
      name: env.repo ? repositoryLabel(env.repo) : env.name,
      repo: env.repo,
      environment: env,
    });
  }
  for (const row of rows.values()) {
    if (row.local && row.repo && !row.environment) {
      row.environment = rows.get(identity(row.repo))?.environment;
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
