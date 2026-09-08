// Product session-token exchange shared by hosted web, desktop main, and backend.

import { assertSecureCloudUrl } from "./cloud-url";

export interface ExchangeCloudSessionTokenParams {
  /** agnt dashboard API origin, e.g. `https://api.agnt.dev`. */
  baseUrl: string;
  /** agnt session id (the provider id) to mint a token for. */
  sessionId: string;
  /** The caller's `deus_cloud_session`, sent as `Authorization: Bearer`. */
  bearer: string;
  /** Token lifetime in seconds (server clamps to 60..86400; default 3600). */
  expiresIn?: number;
}

export interface ExchangeCloudSessionTokenResult {
  token: string;
  expiresIn: number;
}

/** A non-OK exchange, with the HTTP status as data (401 = the bearer lapsed). */
export class SessionTokenExchangeError extends Error {
  constructor(
    readonly status: number,
    sessionId: string
  ) {
    super(`Cloud session token exchange failed (${status}) for session ${sessionId}`);
    this.name = "SessionTokenExchangeError";
  }
}

export async function exchangeCloudSessionToken(
  params: ExchangeCloudSessionTokenParams
): Promise<ExchangeCloudSessionTokenResult> {
  const { baseUrl, sessionId, bearer, expiresIn } = params;
  assertSecureCloudUrl(baseUrl);
  // Encode the id so a hostile value can't steer the request onto another route.
  const url = `${baseUrl.replace(/\/$/, "")}/dashboard/sessions/${encodeURIComponent(sessionId)}/token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    redirect: "error",
  });

  if (!response.ok) {
    // Not-found and not-owned both answer 403 by design (the endpoint refuses
    // to leak which session ids exist), so the status is the actionable fact —
    // carried as a field so callers can route 401 (lapsed bearer) to re-login.
    throw new SessionTokenExchangeError(response.status, sessionId);
  }

  let body: { token?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as { token?: unknown; expires_in?: unknown };
  } catch {
    throw new Error(
      `Cloud session token exchange returned a non-JSON body (${response.status}) for session ${sessionId}`
    );
  }
  if (typeof body?.token !== "string" || !body.token) {
    throw new Error(
      `Cloud session token exchange returned no token (${response.status}) for session ${sessionId}`
    );
  }
  return {
    token: body.token,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : (expiresIn ?? 3600),
  };
}
