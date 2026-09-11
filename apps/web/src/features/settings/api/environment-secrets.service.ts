import { toSnakeCaseKeys, type ProjectEnvironment } from "@deus-hq/api";
import type {
  CloudEnvironmentSettings,
  CloudSecretInput,
  CloudSecretScope,
  CloudSettingsOrganizations,
} from "@shared/types/environment-secrets";
import { requestCloudSettings } from "./cloud-settings.service";

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const product = /^\/orgs\/[^/]+\/github\//.test(path);
  const remotePath =
    path === "/orgs" || product
      ? path
      : path.replace(/^(\/orgs\/[^/?]+)(.*)$/, "$1/environment-settings$2");
  return requestCloudSettings<T>(
    {
      cloud: remotePath,
      desktop: `/settings/environment-secrets${path}`,
      service: product ? "product" : "platform",
    },
    init
  );
}

export const listSecretOrganizations = (signal: AbortSignal) =>
  request<CloudSettingsOrganizations>("/orgs", { signal });
export const listEnvironmentRepositories = (orgId: string, signal: AbortSignal) =>
  request<{ repos: string[] }>(`/orgs/${encodeURIComponent(orgId)}/github/accessible-repos`, {
    signal,
  });
export async function getEnvironmentInstallUrl(orgId: string, signal: AbortSignal) {
  const result = await request<{ url: string }>(
    `/orgs/${encodeURIComponent(orgId)}/github/install-url`,
    { signal }
  );
  const url = new URL(result.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    throw new Error("GitHub connection returned an invalid installation link.");
  return result;
}
export const saveCloudEnvironmentSetup = (
  orgId: string,
  target: { environmentId: string } | { repo: string },
  project: ProjectEnvironment,
  signal: AbortSignal
) =>
  request<{ id: string }>(
    `/orgs/${encodeURIComponent(orgId)}/environments${"environmentId" in target ? `/${encodeURIComponent(target.environmentId)}` : ""}`,
    {
      method: "environmentId" in target ? "PUT" : "POST",
      body: JSON.stringify({ project, ...("repo" in target ? { repo: target.repo } : {}) }),
      signal,
    }
  );
export const getEnvironmentSecretSettings = (
  orgId: string,
  environmentId: string | null,
  signal: AbortSignal
) =>
  request<CloudEnvironmentSettings>(
    `/orgs/${encodeURIComponent(orgId)}${environmentId ? `?environment_id=${encodeURIComponent(environmentId)}` : ""}`,
    { signal }
  );
export const saveEnvironmentSecret = (
  orgId: string,
  name: string,
  input: CloudSecretInput,
  signal: AbortSignal
) =>
  request(`/orgs/${encodeURIComponent(orgId)}/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(toSnakeCaseKeys(input)),
    signal,
  });
export const deleteEnvironmentSecret = (orgId: string, id: string, signal: AbortSignal) =>
  request(`/orgs/${encodeURIComponent(orgId)}/secrets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });

export const importEnvironmentSecrets = (
  orgId: string,
  scope: CloudSecretScope,
  secrets: Array<{ name: string; value: string }>,
  signal: AbortSignal
) =>
  request(`/orgs/${encodeURIComponent(orgId)}/secrets/import`, {
    method: "POST",
    body: JSON.stringify(toSnakeCaseKeys({ ...scope, secrets })),
    signal,
  });

export const getRepositoryEnvironmentFile = (
  orgId: string,
  repository: string,
  signal: AbortSignal
) =>
  request<{ project: ProjectEnvironment | null; branch: string }>(
    `/orgs/${encodeURIComponent(orgId)}/github/environment?repository=${encodeURIComponent(repository)}`,
    { signal }
  );
