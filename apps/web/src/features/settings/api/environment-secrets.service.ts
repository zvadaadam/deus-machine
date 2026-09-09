import { toCamelCaseKeys, toSnakeCaseKeys, type SetupStep } from "@deus-hq/api";
import type {
  CloudEnvironmentSettings,
  CloudSecretInput,
  CloudSettingsOrganizations,
} from "@shared/types/environment-secrets";
import { getBaseURL } from "@/shared/config/api.config";
import { getStoredToken, needsRemoteAuth } from "@/features/auth/hooks/useAuth";
import {
  handleWebCloudSessionExpired,
  isCloudDirectWebMode,
  readWebCloudSessionBearer,
  resolveAgntBaseUrl,
  resolveDeusCloudUrl,
} from "@/features/session/cloud/webCloudDirectConfig";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const direct = isCloudDirectWebMode();
  const bearer = direct
    ? await readWebCloudSessionBearer()
    : needsRemoteAuth()
      ? getStoredToken()
      : null;
  if (direct && !bearer) throw new Error("Sign in to Deus Cloud to manage application secrets.");
  const product = /^\/orgs\/[^/]+\/github\//.test(path);
  const remotePath =
    path === "/orgs" || product
      ? path
      : path.replace(/^(\/orgs\/[^/?]+)(.*)$/, "$1/environment-settings$2");
  const url = direct
    ? `${product ? resolveDeusCloudUrl() : `${resolveAgntBaseUrl()}/dashboard`}${remotePath}`
    : `${await getBaseURL()}/settings/environment-secrets${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]),
    redirect: "error",
  });
  if (!response.ok) {
    if (direct && response.status === 401) handleWebCloudSessionExpired();
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : !init.method || init.method === "GET"
            ? "Couldn't load cloud environment settings."
            : "Couldn't update cloud environment settings."
    );
  }
  return toCamelCaseKeys(await response.json());
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
  setup: SetupStep[],
  signal: AbortSignal
) =>
  request<{ id: string }>(
    `/orgs/${encodeURIComponent(orgId)}/environments${"environmentId" in target ? `/${encodeURIComponent(target.environmentId)}` : ""}`,
    {
      method: "environmentId" in target ? "PUT" : "POST",
      body: JSON.stringify({ setup, ...("repo" in target ? { repo: target.repo } : {}) }),
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
