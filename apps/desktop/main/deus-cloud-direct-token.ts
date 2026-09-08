// The Path B (direct-agnt) token seam, main-process side.
//
// Mints a session-scoped token for a cloud session's agnt socket from the
// desktop's stored `deus_cloud_session` bearer. The bearer NEVER leaves main:
// the renderer receives only the short-lived session token, exactly as it does
// from the backend seam, so exposing this IPC does not widen the credential's
// blast radius.
//
// This is what lets the desktop render + send a cloud session without the org
// API key resolved on the box, and it is the same exchange the web app runs
// against its own WorkOS cookie (there the browser holds the bearer directly).
// Wire: agnt `POST /dashboard/sessions/:id/token` (the #165 exchange).

import { ipcMain } from "electron";
import { getStoredDeusCloudSessionToken } from "./deus-cloud-auth";
import { resolveAgntBaseUrl } from "./deus-cloud-provision";
import { exchangeCloudSessionToken } from "../../../shared/cloud-session-token";

export interface DirectTokenResult {
  token: string;
  base_url: string;
  provider_session_id: string;
  /** Token lifetime in seconds — the renderer re-mints against it. */
  expires_in: number;
}

/** Renderer result shape: a discriminated union so a mint failure is data, not a throw. */
export type DirectTokenResponse = ({ ok: true } & DirectTokenResult) | { ok: false; error: string };

export async function mintDeusCloudDirectToken(
  providerSessionId: string
): Promise<DirectTokenResult> {
  const bearer = await getStoredDeusCloudSessionToken().catch(() => null);
  if (!bearer) throw new Error("Not signed in to Deus Cloud");

  const baseUrl = resolveAgntBaseUrl();
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

/**
 * Register the mint IPC. Kept a leaf module (not folded into `deus-cloud-auth`)
 * for cohesion — the direct-token seam is its own concern, distinct from the
 * session lifecycle in auth.
 */
export function registerDeusCloudDirectTokenHandler(): void {
  ipcMain.handle(
    "deus_cloud:mint_direct_token",
    async (_event, providerSessionId: unknown): Promise<DirectTokenResponse> => {
      if (typeof providerSessionId !== "string" || providerSessionId.length === 0) {
        return { ok: false, error: "A provider session id is required" };
      }
      try {
        const result = await mintDeusCloudDirectToken(providerSessionId);
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Mint failed" };
      }
    }
  );
}
