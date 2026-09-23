import { toSnakeCaseKeys } from "@deus-hq/api";
import {
  isCloudDirectWebMode,
  resolveDeusCloudUrl,
} from "@/features/session/cloud/webCloudDirectConfig";
import { requestCloudSettings } from "./cloud-settings.service";

export interface SlackInstallation {
  id: string;
  teamIdentifier: string;
  teamName: string;
  installedBy: { accountId: string; name: string | null } | null;
  createdAt: string;
}

export interface SlackInstallationsResponse {
  configured: boolean;
  installations: SlackInstallation[];
}

export interface SlackOrganization {
  id: string;
  name: string;
  companyModelAccount: { accountId: string; name: string } | null;
}

function desktop(path: string, orgId: string): string {
  const join = path.includes("?") ? "&" : "?";
  return `/settings/slack${path}${join}organizationId=${encodeURIComponent(orgId)}`;
}

function isLocalHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

export function validateSlackInstallUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack connection returned an invalid link.");
  }
  if (url.protocol !== "https:" && !isLocalHttpUrl(url)) {
    throw new Error("Slack connection returned an invalid link.");
  }
  if (url.pathname !== "/slack/install" || !url.searchParams.has("state")) {
    throw new Error("Slack connection returned an invalid link.");
  }
  if (isCloudDirectWebMode() && url.origin !== new URL(resolveDeusCloudUrl()).origin) {
    throw new Error("Slack connection returned an invalid link.");
  }
  return url.toString();
}

export const listSlackInstallations = (orgId: string, signal: AbortSignal) =>
  requestCloudSettings<SlackInstallationsResponse>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/slack/installations`,
      desktop: desktop("/installations", orgId),
      service: "product",
    },
    { signal }
  );

export async function getSlackInstallUrl(orgId: string, signal: AbortSignal) {
  const result = await requestCloudSettings<{ url: string }>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/slack/install-url`,
      desktop: desktop("/install-url", orgId),
      service: "product",
    },
    { signal }
  );
  return { url: validateSlackInstallUrl(result.url) };
}

export const disconnectSlackInstallation = (
  orgId: string,
  installationId: string,
  signal: AbortSignal
) =>
  requestCloudSettings<{ ok: true }>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/slack/installations/${encodeURIComponent(installationId)}`,
      desktop: desktop(`/installations/${encodeURIComponent(installationId)}`, orgId),
      service: "product",
    },
    { method: "DELETE", signal }
  );

export const getSlackOrganization = (orgId: string, signal: AbortSignal) =>
  requestCloudSettings<SlackOrganization>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}`,
      desktop: desktop("/organization", orgId),
      service: "platform",
    },
    { signal }
  );

export const shareCompanyModelAccount = (orgId: string, signal: AbortSignal) =>
  requestCloudSettings<Pick<SlackOrganization, "companyModelAccount">>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/company-model-account`,
      desktop: desktop("/company-model-account", orgId),
      service: "platform",
    },
    { method: "PUT", signal }
  );

export const stopSharingCompanyModelAccount = (orgId: string, signal: AbortSignal) =>
  requestCloudSettings<{ ok: true }>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/company-model-account`,
      desktop: desktop("/company-model-account", orgId),
      service: "platform",
    },
    { method: "DELETE", signal }
  );

export const saveSlackEnvironmentDescription = (
  orgId: string,
  environmentId: string,
  description: string | null,
  signal: AbortSignal
) =>
  requestCloudSettings<{ id: string; description: string | null }>(
    {
      cloud: `/orgs/${encodeURIComponent(orgId)}/environment-settings/environments/${encodeURIComponent(environmentId)}/description`,
      desktop: desktop(`/environments/${encodeURIComponent(environmentId)}/description`, orgId),
      service: "platform",
    },
    {
      method: "PUT",
      body: JSON.stringify(toSnakeCaseKeys({ description })),
      signal,
    }
  );
