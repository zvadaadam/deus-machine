import { toCamelCaseKeys, toSnakeCaseKeys } from "@deus-hq/api";
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
} from "@/features/session/cloud/webCloudDirectConfig";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const direct = isCloudDirectWebMode();
  const bearer = direct
    ? await readWebCloudSessionBearer()
    : needsRemoteAuth()
      ? getStoredToken()
      : null;
  if (direct && !bearer) throw new Error("Sign in to Deus Cloud to manage application secrets.");
  const remotePath =
    path === "/orgs" ? path : path.replace(/^(\/orgs\/[^/?]+)(.*)$/, "$1/environment-settings$2");
  const url = direct
    ? `${resolveAgntBaseUrl()}/dashboard${remotePath}`
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
  const body = await response.json();
  if (!response.ok) {
    if (direct && response.status === 401) handleWebCloudSessionExpired();
    throw new Error(body.message ?? body.error ?? "Couldn't update cloud environment settings.");
  }
  return toCamelCaseKeys(body);
}

export const listSecretOrganizations = (signal: AbortSignal) =>
  request<CloudSettingsOrganizations>("/orgs", { signal });
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
