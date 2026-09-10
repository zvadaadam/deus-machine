import { toCamelCaseKeys } from "@deus-hq/api";
import type { CloudSettingsOrganizations } from "@shared/types/environment-secrets";
import { AppError } from "../lib/errors";
import { getCloudSettingsConfig, getCloudIdentitySignal } from "./agent/cloud/config";

/** Fixed dashboard paths use the human's session, never the organization SDK key. */
export async function requestCloudEnvironmentSettings(
  path: string,
  init: RequestInit = {},
  service: "platform" | "product" = "platform"
) {
  const config = getCloudSettingsConfig();
  if (!config?.deusCloudSessionToken)
    throw new AppError(401, "Sign in to Deus Cloud to manage application secrets.");
  const identity = getCloudIdentitySignal();
  const base = service === "platform" ? `${config.baseUrl}/dashboard` : config.deusCloudUrl;
  if (!base) throw new AppError(503, "Deus Cloud is not configured.");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.deusCloudSessionToken}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.any([
      identity,
      AbortSignal.timeout(15_000),
      ...(init.signal ? [init.signal] : []),
    ]),
    redirect: "manual",
  });
  const data = response.ok ? await response.json() : await response.json().catch(() => null);
  if (identity.aborted) throw new AppError(409, "Your Deus account changed. Try again.");
  if (!response.ok)
    throw new AppError(
      response.status,
      typeof data?.message === "string"
        ? data.message
        : !init.method || init.method === "GET"
          ? "Couldn't load cloud environment settings."
          : "Couldn't update cloud environment settings."
    );
  return toCamelCaseKeys(data, { opaqueKeys: ["project"] });
}

export async function getCloudSettingsOrganizations(): Promise<CloudSettingsOrganizations> {
  const currentOrganizationId = getCloudSettingsConfig().orgId;
  const data = await requestCloudEnvironmentSettings("/orgs");
  return { ...data, currentOrganizationId };
}

/** SDK user scopes are explicit. Obtain ours from the verified dashboard session. */
export async function getCloudWorkspaceUserId(): Promise<string | undefined> {
  const config = getCloudSettingsConfig();
  if (!config?.deusCloudSessionToken) return undefined;
  const context = await getCloudSettingsOrganizations();
  if (!context.accountId || !context.items.some((org) => org.id === config.orgId)) {
    throw new AppError(403, "Your cloud organization changed. Sign in to Deus Cloud again.");
  }
  return context.accountId;
}
