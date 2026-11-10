// backend/src/services/integrations/auth/mcp-oauth.ts
// OAuth for remote MCP servers, per the MCP authorization spec: protected
// resource discovery, dynamic client registration, PKCE, refresh.
//
// Two paths, kept apart on purpose:
//
//  - **Signing in** runs the SDK's `auth()` (discovery → registration → the
//    authorization URL → the code exchange). An attempt lives in memory: its
//    `state` and PKCE verifier are single-use, a new attempt on the same
//    connection replaces the old one, and none outlives a restart. The
//    sign-in never sees the tokens the connection already holds, so "Connect"
//    always opens the browser and the old sign-in keeps working until the
//    new one lands.
//
//  - **Refreshing** calls the SDK's `refreshAuthorization` directly: one
//    request, whose failure means exactly one of "sign in again" (the grant
//    or client was refused) or "try later" (the network, the server).
//    Refresh belongs to this one module, never to an agent: it is
//    single-flight per connection, because a rotating refresh token used
//    twice signs the account out.
//
// A credential is bound to the server it was issued for: if an app's server
// URL changes, its tokens are never sent to the new address.

import crypto from "crypto";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ZodError } from "zod";
import { getErrorMessage } from "@shared/lib/errors";
import { markNeedsReauth } from "../events";
import { readCredential, updateConnection, writeCredential } from "../store";
import { vaultProblem } from "../vault";
import type { RegisteredClient } from "./clients";

export interface OAuthCredential {
  kind: "oauth";
  /** The MCP server these tokens were issued for. */
  serverUrl: string;
  /** The redirect the dynamically registered client was created with. */
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** Epoch ms the access token expires, from `expires_in` at issue. */
  expiresAt?: number;
  /** Epoch ms of the last refresh, to keep a refused token from refreshing in a loop. */
  refreshedAt?: number;
  discoveryState?: OAuthDiscoveryState;
}

/** How long before expiry a request refreshes the token instead of using it. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** A token refreshed this recently is not refreshed again because a server refused it. */
const FORCED_REFRESH_INTERVAL_MS = 30_000;
/** After a refresh that failed for a passing reason, the next one waits this long. */
const REFRESH_RETRY_MS = 10_000;
/** A sign-in the user did not finish is forgotten after this. */
const ATTEMPT_TTL_MS = 15 * 60_000;
/** Each request of the protocol (discovery, registration, token) gets this long. */
const REQUEST_TIMEOUT_MS = 15_000;

/** `fetch` that gives up: a token endpoint that never answers must not hold a caller. */
const boundedFetch: FetchLike = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

interface Attempt {
  connectionId: string;
  state: string;
  serverUrl: string;
  redirectUrl: string;
  client: RegisteredClient | null;
  codeVerifier?: string;
  expiresAt: number;
}

/** One attempt per connection; `state` finds it from the callback. */
const attempts = new Map<string, Attempt>();

function attemptByState(state: string): Attempt | null {
  const now = Date.now();
  for (const [connectionId, attempt] of attempts) {
    if (attempt.expiresAt <= now) attempts.delete(connectionId);
  }
  if (!state) return null;
  for (const attempt of attempts.values()) {
    const given = Buffer.from(state);
    const wanted = Buffer.from(attempt.state);
    if (given.length === wanted.length && crypto.timingSafeEqual(given, wanted)) return attempt;
  }
  return null;
}

/**
 * The SDK's view of a sign-in in progress. It carries the connection's
 * registered client and discovery across the redirect, keeps the PKCE
 * verifier in the attempt, and hands the new tokens to `landed`.
 */
class SignInProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  landed: OAuthTokens | null = null;
  private credential: OAuthCredential;

  constructor(private readonly attempt: Attempt) {
    const stored = readCredential<OAuthCredential>(attempt.connectionId);
    const sameServer = stored?.kind === "oauth" && stored.serverUrl === attempt.serverUrl;
    this.credential = {
      kind: "oauth",
      serverUrl: attempt.serverUrl,
      // A client registered for another redirect (the backend's port moved)
      // cannot complete a sign-in here: register again.
      ...(sameServer && stored.redirectUrl === attempt.redirectUrl
        ? { clientInformation: stored.clientInformation, redirectUrl: stored.redirectUrl }
        : {}),
      ...(sameServer ? { discoveryState: stored.discoveryState } : {}),
    };
  }

  get redirectUrl(): string {
    return this.attempt.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Deus",
      client_uri: "https://deusmachine.ai",
      redirect_uris: [this.attempt.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.attempt.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const fixed = this.attempt.client;
    if (fixed) {
      return {
        client_id: fixed.client_id,
        ...(fixed.client_secret ? { client_secret: fixed.client_secret } : {}),
      };
    }
    return this.credential.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    if (this.attempt.client) return;
    this.credential.clientInformation = info;
    this.credential.redirectUrl = this.attempt.redirectUrl;
  }

  /** A sign-in never refreshes: what the connection holds stays out of it. */
  tokens(): undefined {
    return undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.landed = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.attempt.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.attempt.codeVerifier) throw new Error("No sign-in is in progress");
    return this.attempt.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.credential.discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.credential.discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.credential.clientInformation = undefined;
    if (scope === "all" || scope === "discovery") this.credential.discoveryState = undefined;
    if (scope === "verifier") this.attempt.codeVerifier = undefined;
  }

  /** The client and discovery this sign-in settled on, with the tokens it won. */
  result(): OAuthCredential {
    return { ...this.credential, ...withTokens(this.landed, undefined) };
  }

  /** The client and discovery so far, over whatever the connection already holds. */
  progress(): OAuthCredential | null {
    const stored = readCredential<OAuthCredential>(this.attempt.connectionId);
    const keep = stored?.kind === "oauth" && stored.serverUrl === this.credential.serverUrl;
    return {
      ...(keep ? stored : {}),
      ...this.credential,
    };
  }
}

function withTokens(
  tokens: OAuthTokens | null,
  previousRefreshToken: string | undefined
): Pick<OAuthCredential, "tokens" | "expiresAt" | "refreshedAt"> {
  if (!tokens) return {};
  // A refresh response may omit the refresh token: the one we hold still stands.
  const refresh = tokens.refresh_token ?? previousRefreshToken;
  return {
    tokens: { ...tokens, ...(refresh ? { refresh_token: refresh } : {}) },
    expiresAt:
      typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined,
    refreshedAt: Date.now(),
  };
}

/** Begin a sign-in and return the page to open in the browser. */
export async function beginOAuth(input: {
  connectionId: string;
  serverUrl: string;
  redirectUrl: string;
  client?: RegisteredClient | null;
}): Promise<string> {
  const attempt: Attempt = {
    connectionId: input.connectionId,
    state: crypto.randomBytes(32).toString("base64url"),
    serverUrl: input.serverUrl,
    redirectUrl: input.redirectUrl,
    client: input.client ?? null,
    expiresAt: Date.now() + ATTEMPT_TTL_MS,
  };
  const provider = new SignInProvider(attempt);
  const result = await auth(provider, { serverUrl: input.serverUrl, fetchFn: boundedFetch });
  if (result !== "REDIRECT" || !provider.authorizationUrl) {
    throw new Error("The server did not offer a sign-in page");
  }
  // Keep the registered client: the callback exchanges the code as it. Tokens
  // the connection already holds stay until the new sign-in lands.
  const progress = provider.progress();
  if (!progress || !writeCredential(input.connectionId, progress)) {
    throw new Error("The connection was removed before its sign-in began");
  }
  // The newest attempt wins: an older tab's callback finds nothing.
  attempts.set(input.connectionId, attempt);
  return provider.authorizationUrl.toString();
}

/** The connection a callback's `state` belongs to, without consuming it. */
export function attemptFor(state: string): string | null {
  return attemptByState(state)?.connectionId ?? null;
}

/** Finish a sign-in from the redirect. Throws when the state is unknown, stale or already used. */
export async function completeOAuth(input: { state: string; code: string }): Promise<string> {
  const attempt = attemptByState(input.state);
  if (!attempt) throw new Error("This sign-in link has expired. Start again from Deus.");
  attempts.delete(attempt.connectionId);
  const provider = new SignInProvider(attempt);
  const result = await auth(provider, {
    serverUrl: attempt.serverUrl,
    authorizationCode: input.code,
    fetchFn: boundedFetch,
  });
  if (result !== "AUTHORIZED" || !provider.landed) {
    throw new Error("The server did not accept the sign-in");
  }
  const credential = provider.result();
  if (!writeCredential(attempt.connectionId, credential)) {
    throw new Error("The connection was removed before its sign-in finished");
  }
  updateConnection(attempt.connectionId, {
    status: "active",
    lastError: null,
    label: labelFromIdToken(credential.tokens?.id_token),
  });
  return attempt.connectionId;
}

/** Forget a sign-in the provider turned down (the user denied it). */
export function abandonOAuth(state: string): string | null {
  const attempt = attemptByState(state);
  if (attempt) attempts.delete(attempt.connectionId);
  return attempt?.connectionId ?? null;
}

/** Forget whatever sign-in a connection has in progress (it was removed). */
export function forgetOAuth(connectionId: string): void {
  attempts.delete(connectionId);
  refreshFlights.delete(connectionId);
  refreshFailures.delete(connectionId);
}

/** An OpenID id_token's email or name, when the server sent one (unverified: display only). */
function labelFromIdToken(idToken: string | undefined): string | null | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    const label = payload.email ?? payload.preferred_username ?? payload.name;
    return typeof label === "string" ? label.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Using and refreshing
// ---------------------------------------------------------------------------

const refreshFlights = new Map<string, Promise<string | null>>();
/** When each connection's refresh last failed for a passing reason, and why. */
const refreshFailures = new Map<string, { at: number; reason: string }>();

/**
 * Whether a failed refresh means the grant is gone. The token endpoint said
 * no, in OAuth's words or its own: anything but "the server is having a bad
 * time" is final, including a 2xx whose body is an error (some servers).
 * A network failure, a timeout or a page that is not JSON is not.
 */
function refused(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  return (
    error instanceof OAuthError &&
    !(error instanceof ServerError) &&
    !(error instanceof TemporarilyUnavailableError) &&
    !(error instanceof TooManyRequestsError)
  );
}

/**
 * The access token a request should send. It is refreshed first when it is
 * about to expire, or when `force` says a server just refused it. Null means
 * the account must sign in again (the connection is marked `needs_reauth`).
 * A refresh that fails for a passing reason keeps a token that is still
 * valid, and throws when there is none to keep.
 */
export async function oauthAccessToken(
  connectionId: string,
  serverUrl: string,
  client?: RegisteredClient | null,
  options: { force?: boolean } = {}
): Promise<string | null> {
  const credential = readCredential<OAuthCredential>(connectionId);
  const problem = credential ? null : vaultProblem();
  if (problem) throw new Error(problem);
  const token = credential?.tokens?.access_token;
  if (!credential || credential.kind !== "oauth" || !token) return null;
  if (credential.serverUrl !== serverUrl) {
    markNeedsReauth(connectionId, "Its server address changed; sign in again");
    return null;
  }
  const now = Date.now();
  const expiring =
    credential.expiresAt !== undefined && credential.expiresAt - now < REFRESH_MARGIN_MS;
  const refused =
    options.force === true && now - (credential.refreshedAt ?? 0) > FORCED_REFRESH_INTERVAL_MS;
  if (!expiring && !refused) return token;

  if (!credential.tokens?.refresh_token) {
    const stillValid =
      !refused && (credential.expiresAt === undefined || credential.expiresAt > now);
    if (!stillValid) markNeedsReauth(connectionId, "The sign-in expired");
    return stillValid ? token : null;
  }

  // A token endpoint that is down is not asked again on every request.
  const failure = refreshFailures.get(connectionId);
  if (failure && now - failure.at < REFRESH_RETRY_MS) {
    if (credential.expiresAt === undefined || credential.expiresAt > now) return token;
    throw new Error(`Could not refresh the sign-in: ${failure.reason}`);
  }

  let flight = refreshFlights.get(connectionId);
  if (!flight) {
    flight = refresh(connectionId, credential, client ?? null).finally(() => {
      if (refreshFlights.get(connectionId) === flight) refreshFlights.delete(connectionId);
    });
    refreshFlights.set(connectionId, flight);
  }
  return flight;
}

async function refresh(
  connectionId: string,
  credential: OAuthCredential,
  client: RegisteredClient | null
): Promise<string | null> {
  const sent = credential.tokens!.refresh_token!;
  const clientInformation: OAuthClientInformationMixed | undefined = client
    ? {
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      }
    : credential.clientInformation;
  if (!clientInformation) {
    markNeedsReauth(connectionId, "The sign-in is incomplete");
    return null;
  }
  try {
    const discovery =
      credential.discoveryState ??
      (await discoverOAuthServerInfo(credential.serverUrl, { fetchFn: boundedFetch }));
    const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      refreshToken: sent,
      resource: discovery.resourceMetadata?.resource
        ? new URL(discovery.resourceMetadata.resource)
        : undefined,
      fetchFn: boundedFetch,
    });
    const next: OAuthCredential = {
      ...credential,
      discoveryState: discovery,
      ...withTokens(tokens, sent),
    };
    // The connection may have been removed while the request was out.
    if (!writeCredential(connectionId, next)) return null;
    refreshFailures.delete(connectionId);
    updateConnection(connectionId, { status: "active", lastError: null });
    return next.tokens?.access_token ?? null;
  } catch (error) {
    const latest = readCredential<OAuthCredential>(connectionId);
    // Someone else rotated the token while we asked (another Deus process on
    // this database): theirs is the one that stands.
    if (latest?.tokens?.refresh_token && latest.tokens.refresh_token !== sent) {
      return latest.tokens.access_token;
    }
    if (refused(error)) {
      markNeedsReauth(connectionId, "The sign-in was revoked or expired");
      return null;
    }
    const reason = getErrorMessage(error);
    refreshFailures.set(connectionId, { at: Date.now(), reason });
    const stillValid = credential.expiresAt === undefined || credential.expiresAt > Date.now();
    if (stillValid) return credential.tokens!.access_token;
    throw new Error(`Could not refresh the sign-in: ${reason}`);
  }
}

/** @internal */
export function __resetOAuthForTests(): void {
  attempts.clear();
  refreshFlights.clear();
  refreshFailures.clear();
}
