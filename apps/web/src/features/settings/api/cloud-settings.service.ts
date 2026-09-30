import { toCamelCaseKeys } from "@deus-hq/api";
import { getBaseURL } from "@/shared/config/api.config";
import { getStoredToken, needsRemoteAuth } from "@/features/auth/hooks/useAuth";
import {
  handleWebCloudSessionExpired,
  isCloudDirectWebMode,
  readWebCloudSessionBearer,
  resolveAgntBaseUrl,
  resolveDeusCloudUrl,
} from "@/features/session/cloud/webCloudDirectConfig";

export class CloudSettingsError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "CloudSettingsError";
    this.status = status;
    this.code = code;
  }
}

/** Fixed settings routes share account authentication on desktop and direct web. */
export async function requestCloudSettings<T>(
  paths: { cloud: string; desktop: string; service?: "platform" | "product" },
  init: RequestInit = {}
): Promise<T> {
  const direct = isCloudDirectWebMode();
  const bearer = direct
    ? await readWebCloudSessionBearer()
    : needsRemoteAuth()
      ? getStoredToken()
      : null;
  if (direct && !bearer) throw new Error("Sign in to Deus Cloud to manage cloud settings.");
  const cloudBase =
    paths.service === "product" ? resolveDeusCloudUrl() : `${resolveAgntBaseUrl()}/dashboard`;
  const url = direct ? `${cloudBase}${paths.cloud}` : `${await getBaseURL()}${paths.desktop}`;
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
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
      code?: unknown;
      details?: { code?: unknown };
    } | null;
    throw new CloudSettingsError(
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : !init.method || init.method === "GET"
            ? "Couldn't load cloud settings."
            : "Couldn't update cloud settings.",
      response.status,
      typeof body?.code === "string"
        ? body.code
        : typeof body?.details?.code === "string"
          ? body.details.code
          : null
    );
  }
  return toCamelCaseKeys(await response.json(), { opaqueKeys: ["project"] });
}
