// The Path B (direct-agnt) token seam, main-process side.
//
// Mints a session-scoped token for a cloud session's agnt socket from the
// desktop's stored `deus_cloud_session` bearer — the WorkOS-sourced twin of the
// backend's org-key `cloud-direct-token` endpoint. The bearer NEVER leaves main:
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
  // Renderer-supplied id: encode so `../`/`?`/`#` can't steer the authed
  // request onto a different agnt route.
  const sessionPath = encodeURIComponent(providerSessionId);
  const response = await fetch(`${baseUrl}/dashboard/sessions/${sessionPath}/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    // Empty body — `expires_in` defaults server-side. The exchange is tolerant of
    // an absent body but rejects malformed JSON, so send a clean `{}`.
    body: "{}",
  });

  if (!response.ok) {
    // 401 here means the stored session lapsed (it refreshes on its own cadence);
    // 403 means the account lost membership in the session's org. Either way the
    // renderer surfaces it as a direct-lane connection error.
    throw new Error(`Session token exchange failed (${response.status})`);
  }

  const body = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.token !== "string") {
    throw new Error("Session token exchange returned no token");
  }
  return {
    token: body.token,
    base_url: baseUrl,
    provider_session_id: providerSessionId,
    // Fall back to the server's own default lifetime if the field is absent.
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 60 * 60,
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
