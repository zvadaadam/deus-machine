// apps/web/src/features/session/cloud/exchangeSessionToken.ts
// Browser session-token exchange — the credential half of the direct-agnt lane.
//
// The browser holds only its `deus_cloud_session` (a WorkOS session cookie/
// bearer), never the org API key. This mints a session-scoped `session_token`
// — the SAME shape the client WebSocket accepts — from that bearer, by calling
// agnt's dashboard exchange endpoint (`POST /dashboard/sessions/:id/token`).
// The engine (cloudSessionSocket) takes the minted token; where the browser
// gets its bearer is a separate, upstream concern.
//
// Wire contract: `apps/backend/src/routes/dashboard/session-tokens.ts` in agnt.
// Request body is snake_case (`expires_in`); the response is snake_case
// (`{ token, expires_in }`) and is normalised to camelCase here.

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
  // Encode the id so a hostile value can't steer the request onto another route.
  const url = `${baseUrl}/dashboard/sessions/${encodeURIComponent(sessionId)}/token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
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
  if (typeof body.token !== "string") {
    throw new Error(
      `Cloud session token exchange returned no token (${response.status}) for session ${sessionId}`
    );
  }
  return {
    token: body.token,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 0,
  };
}
