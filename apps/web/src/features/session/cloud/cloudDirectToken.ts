// apps/web/src/features/session/cloud/cloudDirectToken.ts
// Token-source selection for the direct-agnt lane (Path B).
//
// The lane needs one thing to open a cloud session's socket: a session-scoped
// token (+ the agnt base URL). WHERE that token is minted depends on what the
// client is:
//
//   - backend seam — the Mac backend mints it from the org API key
//     (`cloudDirectToken` q: → GET /sessions/:id/cloud-direct-token). The default
//     whenever a Mac backend is reachable (electron, web-dev, relay).
//   - WorkOS desktop mint — Electron main mints it from the stored
//     `deus_cloud_session` bearer (bearer stays in main; only the token crosses
//     to the renderer). The Mac-closed source ON the desktop.
//   - WorkOS web exchange — the browser mints it from its OWN WorkOS session
//     (cookie), directly against agnt's `/dashboard` exchange. The fully
//     Mac-closed WEB source, where there is no Mac backend at all.
//
// All three return the SAME shape, so `useCloudDirect` is source-agnostic.

import { sendRequest } from "@/platform/ws";
import { capabilities } from "@/platform/capabilities";
import { exchangeCloudSessionToken } from "./exchangeSessionToken";
import {
  resolveAgntBaseUrl,
  readWebCloudSessionBearer,
  isCloudDirectWebMode,
} from "./webCloudDirectConfig";

export interface CloudDirectTokenResponse {
  token: string;
  base_url: string;
  provider_session_id: string;
  /** Token lifetime in seconds (the server's own clamp, 60..86400) — drives the
   *  re-mint cadence so it tracks the server contract instead of a guessed TTL. */
  expires_in: number;
}

export type CloudDirectTokenSource = "backend" | "workos-desktop" | "workos-web";

/** A dev/test override — force a specific source regardless of deployment mode. */
const SOURCE_OVERRIDE_KEY = "deus.cloudDirectTokenSource";

function readSourceOverride(): CloudDirectTokenSource | null {
  try {
    const v = localStorage.getItem(SOURCE_OVERRIDE_KEY);
    return v === "backend" || v === "workos-desktop" || v === "workos-web" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Which source mints this client's direct tokens. The default is the backend
 * seam whenever a Mac backend is reachable; a browser with no backend (fully
 * Mac-closed web) mints from its own WorkOS session. The override exists so the
 * WorkOS path is exercisable on a machine that also has a backend (testing).
 */
export function pickCloudDirectTokenSource(): CloudDirectTokenSource {
  const override = readSourceOverride();
  if (override) return override;
  // Fully Mac-closed web build → the browser is the only client, so it mints from
  // its own WorkOS session. Every other build (electron / web-dev / relay) has a
  // Mac backend and uses the org-key seam.
  return isCloudDirectWebMode() ? "workos-web" : "backend";
}

export async function resolveCloudDirectToken(
  sessionId: string,
  providerSessionId: string | null | undefined
): Promise<CloudDirectTokenResponse> {
  switch (pickCloudDirectTokenSource()) {
    case "workos-desktop":
      return mintViaDesktop(providerSessionId);
    case "workos-web":
      return mintViaWebExchange(providerSessionId);
    default:
      // The backend maps deus sessionId → provider session id + base URL itself.
      return sendRequest<CloudDirectTokenResponse>("cloudDirectToken", { sessionId });
  }
}

/** Desktop: mint in main from the stored bearer (see deus-cloud-direct-token.ts). */
async function mintViaDesktop(
  providerSessionId: string | null | undefined
): Promise<CloudDirectTokenResponse> {
  if (!providerSessionId) throw new Error("This session has no cloud provider to mint a token for");
  if (!capabilities.ipcInvoke || !window.electronAPI?.mintDeusCloudDirectToken) {
    throw new Error("The desktop WorkOS token mint is unavailable");
  }
  const result = await window.electronAPI.mintDeusCloudDirectToken(providerSessionId);
  if (!result.ok) throw new Error(result.error);
  return {
    token: result.token,
    base_url: result.base_url,
    provider_session_id: result.provider_session_id,
    expires_in: result.expires_in,
  };
}

/** Web (fully Mac-closed): mint from the browser's own WorkOS session bearer. */
async function mintViaWebExchange(
  providerSessionId: string | null | undefined
): Promise<CloudDirectTokenResponse> {
  if (!providerSessionId) throw new Error("This session has no cloud provider to mint a token for");
  const baseUrl = resolveAgntBaseUrl();
  const bearer = await readWebCloudSessionBearer();
  if (!bearer) throw new Error("Sign in to Deus Cloud to open this session");
  const { token, expiresIn } = await exchangeCloudSessionToken({
    baseUrl,
    sessionId: providerSessionId,
    bearer,
  });
  return {
    token,
    base_url: baseUrl,
    provider_session_id: providerSessionId,
    expires_in: expiresIn,
  };
}
