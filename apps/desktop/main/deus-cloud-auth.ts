import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "../../../shared/types";
import { getCloudCredentialsStatus } from "./cloud-credentials";
import { logMainProcess } from "./startup-diagnostics";
import {
  decryptSecret,
  encryptSecret,
  readJsonFile,
  removeFile,
  userDataFilePath,
  isSafeStorageAvailable,
  writeJsonFile,
} from "./safe-storage-file";
import {
  getPlatformKeyError,
  provisionAfterLogin,
  retryDeviceKeyProvisioning,
  revokeDeviceKey,
} from "./deus-cloud-provision";
import {
  buildDesktopLoginUrl,
  createDesktopPkcePair,
  createDesktopState,
  DEUS_CLOUD_DESKTOP_CALLBACK_PATH,
  type DesktopAuthConfig,
  type DesktopAuthCallback,
  parseDesktopAuthCallbackUrl,
  resolveDesktopRedirectUri,
  resolveDeusCloudUrl,
} from "./deus-cloud-auth-contract";

const SESSION_FILE_NAME = "deus-cloud-session.json";
const SESSION_FILE_VERSION = 1;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

interface StoredDeusCloudSession {
  version: typeof SESSION_FILE_VERSION;
  accountId: string;
  /** Human identity from deus-cloud /me — the account id alone reads as a
   *  database row, not as "you". Optional: a /me failure must never block
   *  a sign-in that otherwise succeeded. */
  accountName?: string;
  accountEmail?: string;
  tokenType: "Bearer";
  expiresAt: string;
  encryptedSessionToken: string;
  /** WorkOS refresh token (rotating), encrypted like the session itself.
   *  Absent for sessions stored before refresh existed — those simply expire
   *  the old way and the user signs in once more. */
  encryptedRefreshToken?: string;
  cloudUrl: string;
  createdAt: string;
}

interface DesktopExchangeResponse {
  session_token?: string;
  token_type?: string;
  expires_in_seconds?: number;
  account_id?: string;
  refresh_token?: string;
}

interface DesktopAuthConfigResponse {
  authorization_endpoint?: string;
  client_id?: string;
  provider?: string;
  redirect_uri?: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  cloudUrl: string;
  closeCallbackServer: () => Promise<void>;
  timeout: NodeJS.Timeout;
  resolve: (value: DeusCloudAuthResult) => void;
  reject: (error: Error) => void;
}

interface DesktopCallbackServer {
  redirectUri: string;
  waitForCallback: Promise<DesktopAuthCallback>;
  close: () => Promise<void>;
}

let pendingLogin: PendingLogin | null = null;
let loginStartInProgress = false;
let loginGeneration = 0;

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cloudEndpointUrl(cloudUrl: string, path: string): URL {
  const url = new URL(cloudUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const endpointPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${endpointPath}`;
  url.search = "";
  url.hash = "";
  return url;
}

function getSessionFilePath(): string {
  return userDataFilePath(SESSION_FILE_NAME);
}

function toPublicStatus(
  stored: StoredDeusCloudSession | null,
  cloudUrl = resolveDeusCloudUrl()
): DeusCloudSessionStatus {
  if (!stored) {
    return {
      signedIn: false,
      accountId: null,
      expiresAt: null,
      tokenType: null,
      cloudUrl,
      hasPlatformKey: false,
    };
  }

  return {
    signedIn: true,
    accountId: stored.accountId,
    accountName: stored.accountName ?? null,
    accountEmail: stored.accountEmail ?? null,
    expiresAt: stored.expiresAt,
    tokenType: stored.tokenType,
    cloudUrl: stored.cloudUrl,
    hasPlatformKey: false,
    platformKeyError: getPlatformKeyError(),
  };
}

/** Overlay device-key presence onto a session status (never the value). */
async function enrichWithCredentialStatus(
  status: DeusCloudSessionStatus
): Promise<DeusCloudSessionStatus> {
  const creds = await getCloudCredentialsStatus().catch(() => null);
  return {
    ...status,
    hasPlatformKey: creds?.hasPlatformKey ?? false,
    ...(creds?.vaultLocked ? { vaultLocked: true } : {}),
  };
}

/**
 * The loopback page the browser lands on after WorkOS redirects back. It is
 * the last thing a user sees during sign-in, and a bare Times New Roman
 * sentence on 127.0.0.1 reads like something broke. Self-contained (no
 * network, no assets — this server dies seconds later) and dark-first, since
 * it is only ever shown for a moment before focus returns to the app.
 */
/** Bring the Deus window to the front (post-sign-in, from the loopback server). */
function focusMainWindow(): void {
  try {
    app.focus({ steal: true });
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } catch {
    // Focus is a courtesy; never let it break a completed sign-in.
  }
}

function respondHtml(res: ServerResponse, status: number, message: string, ok = false): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  const mark = ok
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>`;
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deus</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0a; color: #fafafa;
    font: 400 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { text-align: center; padding: 40px 32px; max-width: 380px; }
  .badge {
    width: 48px; height: 48px; margin: 0 auto 20px; border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    background: ${ok ? "rgba(52,199,89,.12)" : "rgba(255,255,255,.06)"};
    color: ${ok ? "#34c759" : "rgba(250,250,250,.55)"};
  }
  .badge svg { width: 24px; height: 24px; }
  h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; font-size: 14px; color: rgba(250,250,250,.5); }
  @media (prefers-color-scheme: light) {
    body { background: #fafafa; color: #0a0a0a; }
    p { color: rgba(10,10,10,.5); }
  }
</style></head>
<body><div class="card">
  <div class="badge">${mark}</div>
  <h1>${message}</h1>
  <p>You can close this tab and return to Deus.</p>
</div>
<script>
  // Best-effort: only works for script-opened windows, so the copy above
  // never depends on it.
  setTimeout(() => { try { window.close(); } catch (_) {} }, 1200);
</script>
</body></html>`);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function createDesktopCallbackServer(expectedState: string): Promise<DesktopCallbackServer> {
  let settled = false;
  let resolveCallback: (callback: DesktopAuthCallback) => void = () => {};
  let rejectCallback: (error: Error) => void = () => {};

  const waitForCallback = new Promise<DesktopAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (requestUrl.pathname !== DEUS_CLOUD_DESKTOP_CALLBACK_PATH) {
      respondHtml(res, 404, "Not Found");
      return;
    }

    if (settled) {
      respondHtml(res, 409, "This sign-in link was already used");
      return;
    }

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Desktop callback server is unavailable");
      }

      const callback = parseDesktopAuthCallbackUrl(
        `http://127.0.0.1:${address.port}${requestUrl.pathname}${requestUrl.search}`
      );
      if (callback.state !== expectedState) {
        throw new Error("Deus Cloud sign-in state did not match");
      }

      settled = true;
      // Deliberately NOT "Signed in": the code-for-session exchange has not
      // run yet, and it can still fail. Claiming success here left the
      // browser saying one thing and the app showing another.
      respondHtml(res, 200, "Finishing sign-in — you can close this tab", true);
      // Pull the app forward: the user's attention is in the browser, and
      // window.close() only works for script-opened tabs, so without this
      // they are left looking at a success page wondering what happens next.
      focusMainWindow();
      resolveCallback(callback);
    } catch (error) {
      settled = true;
      respondHtml(res, 400, "Sign-in failed");
      rejectCallback(error instanceof Error ? error : new Error("Deus Cloud sign-in failed"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not start desktop callback server");
  }

  return {
    redirectUri: `http://127.0.0.1:${(address as AddressInfo).port}${DEUS_CLOUD_DESKTOP_CALLBACK_PATH}`,
    waitForCallback,
    close: async () => {
      if (!settled) {
        settled = true;
        rejectCallback(new Error("Deus Cloud sign-in was cancelled"));
      }
      await closeServer(server);
    },
  };
}

/** Renew this far ahead of expiry, so a session is never used near its edge. */
const SESSION_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Read + structurally validate the file. Expiry is NOT judged here: an
 *  expired session with a refresh token is still renewable. */
async function readSessionFile(): Promise<StoredDeusCloudSession | null> {
  try {
    const parsed =
      (await readJsonFile<Partial<StoredDeusCloudSession>>(getSessionFilePath())) ?? {};
    if (
      parsed.version !== SESSION_FILE_VERSION ||
      typeof parsed.accountId !== "string" ||
      parsed.tokenType !== "Bearer" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.encryptedSessionToken !== "string" ||
      typeof parsed.cloudUrl !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    // A locked keyring throws BEFORE decryption is attempted, so it proves
    // nothing about the ciphertext. Discarding the session there would sign
    // the user out over a condition that clears on its own.
    if (!isSafeStorageAvailable()) return null;
    try {
      decryptSessionToken(parsed.encryptedSessionToken);
    } catch {
      await clearStoredSession();
      return null;
    }
    return parsed as StoredDeusCloudSession;
  } catch {
    return null;
  }
}

/** In-flight refresh, so concurrent callers share one round-trip (and one
 *  use of the rotating token — WorkOS invalidates it on first use). */
let refreshInFlight: Promise<StoredDeusCloudSession | null> | null = null;
/** Set for the duration of sign-out; see the guard in refreshStoredSession. */
let signOutInProgress = false;
/**
 * Floor on how often a NON-expired session may be renewed.
 *
 * The window below is absolute, so any token whose own lifetime is shorter
 * than it is permanently "near expiry" — every single session read would
 * then make a network round-trip, and every settings render would block on
 * one. Production issues 24h tokens today, but a server-side tightening to,
 * say, 4h must not turn into a refresh storm.
 */
const SESSION_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
let lastRefreshAt = 0;

/**
 * Set by the provisioning module at startup. A plain callback rather than an
 * import, because deus-cloud-provision already imports from here.
 */
let onSessionRefreshed: (() => void | Promise<void>) | null = null;

export function setSessionRefreshedHandler(handler: () => void | Promise<void>): void {
  onSessionRefreshed = handler;
}

/** The replacement token deus-cloud attaches when it fails after rotating. */
async function readRotatedRefreshToken(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { refresh_token?: unknown };
    return typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : null;
  } catch {
    return null;
  }
}

async function refreshStoredSession(
  stored: StoredDeusCloudSession
): Promise<StoredDeusCloudSession | null> {
  if (!stored.encryptedRefreshToken) return null;
  let refreshToken: string;
  try {
    refreshToken = decryptSessionToken(stored.encryptedRefreshToken);
  } catch {
    return null;
  }

  const response = await fetch(`${stored.cloudUrl}/auth/desktop/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401) {
    // Revoked, expired, or already rotated — the only honest outcome is to
    // sign out rather than keep a session that cannot be renewed.
    await clearStoredSession();
    return null;
  }
  if (!response.ok) {
    // WorkOS rotates on every use, so a failure AFTER rotation leaves the
    // token we hold dead. deus-cloud returns the replacement on the error
    // body for exactly this case — persist it, or the next retry presents a
    // token that can never succeed and the user is forced to sign in again.
    const rotated = await readRotatedRefreshToken(response);
    if (rotated) {
      await writeStoredSession({
        ...stored,
        encryptedRefreshToken: encryptSessionToken(rotated),
      });
      logMainProcess("[deus-cloud] refresh failed after rotation — kept the replacement token");
    }
    // Server-side problem (503 CONFIG_ERROR, network): keep what we have.
    throw new Error(`session refresh failed (${response.status})`);
  }

  const body = (await response.json()) as DesktopExchangeResponse;
  if (!body.session_token || typeof body.expires_in_seconds !== "number") {
    throw new Error("Deus Cloud returned an invalid refreshed session");
  }

  // Backfill the human identity if sign-in never got it. /me is best-effort
  // AT SIGN-IN, and nothing else re-fetches it — so one transient failure
  // there used to leave the account showing as a database row forever.
  const profile =
    stored.accountName || stored.accountEmail
      ? null
      : await fetchAccountProfile(stored.cloudUrl, body.session_token);

  const next: StoredDeusCloudSession = {
    ...stored,
    ...(profile?.name ? { accountName: profile.name } : {}),
    ...(profile?.email ? { accountEmail: profile.email } : {}),
    expiresAt: new Date(Date.now() + body.expires_in_seconds * 1000).toISOString(),
    encryptedSessionToken: encryptSessionToken(body.session_token),
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { encryptedRefreshToken: encryptSessionToken(body.refresh_token) }
      : {}),
  };
  if (signOutInProgress) {
    // Sign-out already cleared the session; writing the renewed one back
    // would resurrect it, and the push below would hand the backend a live
    // token for an account the user just left. A generation counter does NOT
    // catch this — signOutDeusCloud bumps it first, so a refresh started
    // afterwards carries the current value and passes.
    return null;
  }
  await writeStoredSession(next);
  logMainProcess("[deus-cloud] session refreshed");
  // The backend holds its OWN copy of the session token (it mints GitHub App
  // installation tokens with it) and only ever receives one on an explicit
  // push. Without this, a silently refreshed desktop keeps working while the
  // backend's copy quietly expires and every mint starts 401ing.
  void onSessionRefreshed?.();
  return next;
}

/**
 * The session every caller should read. Renews silently when it is close to
 * expiry (or already past it) so a signed-in machine stays signed in — a
 * desktop app that logs you out daily is the thing this avoids.
 */
async function readStoredSession(): Promise<StoredDeusCloudSession | null> {
  const stored = await readSessionFile();
  if (!stored) return null;

  const expiresAt = parseTimestamp(stored.expiresAt);
  const expired = !expiresAt || expiresAt <= Date.now();
  const nearExpiry = expiresAt !== null && expiresAt - Date.now() <= SESSION_REFRESH_WINDOW_MS;

  if (!expired && !nearExpiry) return stored;

  if (!stored.encryptedRefreshToken) {
    // Pre-refresh session (or the token was never issued): old behaviour.
    if (expired) {
      await clearStoredSession();
      return null;
    }
    return stored;
  }

  // An expired token is unusable, so it always retries; a merely near-expiry
  // one waits out the floor and keeps serving in the meantime.
  if (!expired && Date.now() - lastRefreshAt < SESSION_REFRESH_MIN_INTERVAL_MS) return stored;

  refreshInFlight ??= refreshStoredSession(stored).finally(() => {
    // After the write inside refreshStoredSession, which resets it to 0.
    lastRefreshAt = Date.now();
    refreshInFlight = null;
  });

  try {
    const refreshed = await refreshInFlight;
    if (refreshed) return refreshed;
    return null; // 401 path already cleared the session
  } catch (error) {
    logMainProcess(
      `[deus-cloud] session refresh failed: ${error instanceof Error ? error.message : String(error)}`
    );
    // Transient failure: a still-valid session keeps working; an expired one
    // cannot be used, but is kept on disk so the next attempt can retry.
    return expired ? null : stored;
  }
}

async function writeStoredSession(session: StoredDeusCloudSession): Promise<void> {
  // The floor belongs to the token that was refreshed, not to the process: a
  // fresh sign-in (or a rotation) must be free to renew immediately.
  lastRefreshAt = 0;
  await writeJsonFile(getSessionFilePath(), session);
}

async function clearStoredSession(): Promise<void> {
  lastRefreshAt = 0;
  await removeFile(getSessionFilePath());
}

const encryptSessionToken = encryptSecret;
const decryptSessionToken = decryptSecret;

function parseDesktopAuthConfig(body: DesktopAuthConfigResponse | null): DesktopAuthConfig {
  if (
    !body ||
    typeof body.authorization_endpoint !== "string" ||
    typeof body.client_id !== "string" ||
    body.provider !== "authkit" ||
    typeof body.redirect_uri !== "string"
  ) {
    throw new Error("Deus Cloud returned invalid desktop login configuration");
  }

  const endpoint = new URL(body.authorization_endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Deus Cloud returned invalid WorkOS authorization endpoint");
  }

  if (body.client_id.length === 0) {
    throw new Error("Deus Cloud returned an empty WorkOS client ID");
  }
  resolveDesktopRedirectUri(body.redirect_uri, 1);

  return {
    authorizationEndpoint: endpoint.toString(),
    clientId: body.client_id,
    provider: "authkit",
    redirectUri: body.redirect_uri,
  };
}

async function fetchDesktopAuthConfig(cloudUrl: string): Promise<DesktopAuthConfig> {
  const response = await fetch(cloudEndpointUrl(cloudUrl, "/auth/desktop/config"));
  const body = (await response.json().catch(() => null)) as DesktopAuthConfigResponse | null;

  if (!response.ok) {
    throw new Error("Deus Cloud desktop login is not configured");
  }

  return parseDesktopAuthConfig(body);
}

async function exchangeDesktopCode(input: {
  cloudUrl: string;
  code: string;
  verifier: string;
}): Promise<StoredDeusCloudSession> {
  const response = await fetch(cloudEndpointUrl(input.cloudUrl, "/auth/desktop/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: input.code,
      code_verifier: input.verifier,
    }),
  });

  const body = (await response.json().catch(() => null)) as DesktopExchangeResponse | null;
  if (!response.ok) {
    throw new Error("Deus Cloud rejected the desktop login");
  }

  if (
    !body ||
    typeof body.session_token !== "string" ||
    body.session_token.length === 0 ||
    body.token_type !== "Bearer" ||
    typeof body.account_id !== "string" ||
    body.account_id.length === 0 ||
    typeof body.expires_in_seconds !== "number" ||
    !Number.isFinite(body.expires_in_seconds) ||
    body.expires_in_seconds <= 0
  ) {
    throw new Error("Deus Cloud returned an invalid desktop session");
  }

  const profile = await fetchAccountProfile(input.cloudUrl, body.session_token);

  return {
    version: SESSION_FILE_VERSION,
    accountId: body.account_id,
    ...(profile.name ? { accountName: profile.name } : {}),
    ...(profile.email ? { accountEmail: profile.email } : {}),
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { encryptedRefreshToken: encryptSessionToken(body.refresh_token) }
      : {}),
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + body.expires_in_seconds * 1000).toISOString(),
    encryptedSessionToken: encryptSessionToken(body.session_token),
    cloudUrl: input.cloudUrl,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Human identity for the signed-in account. Best-effort by design: the
 * session is already valid at this point, so a /me failure degrades the
 * Account card to the raw id rather than failing the sign-in.
 */
async function fetchAccountProfile(
  cloudUrl: string,
  sessionToken: string
): Promise<{ name?: string; email?: string }> {
  try {
    const response = await fetch(`${cloudUrl}/me`, {
      headers: { authorization: `Bearer ${sessionToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { account?: { name?: unknown; email?: unknown } };
    return {
      ...(typeof body.account?.name === "string" ? { name: body.account.name } : {}),
      ...(typeof body.account?.email === "string" ? { email: body.account.email } : {}),
    };
  } catch {
    return {};
  }
}

function broadcastAuthChanged(status: DeusCloudSessionStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("deus_cloud:changed", status);
    }
  }
}

function finishPendingLogin(
  error: Error | null,
  status?: DeusCloudSessionStatus,
  expectedPending?: PendingLogin
): void {
  const pending = pendingLogin;
  if (!pending) return;
  if (expectedPending && pending !== expectedPending) return;
  clearTimeout(pending.timeout);
  pendingLogin = null;
  void pending.closeCallbackServer();

  if (error) {
    pending.reject(error);
    return;
  }

  pending.resolve({
    success: true,
    session: status ?? toPublicStatus(null, pending.cloudUrl),
  });
}

export async function getDeusCloudSessionStatus(): Promise<DeusCloudSessionStatus> {
  return enrichWithCredentialStatus(toPublicStatus(await readStoredSession()));
}

export async function getStoredDeusCloudSessionToken(): Promise<string | null> {
  const session = await readStoredSession();
  if (!session) return null;
  try {
    return decryptSessionToken(session.encryptedSessionToken);
  } catch {
    await clearStoredSession();
    return null;
  }
}

export async function signOutDeusCloud(): Promise<DeusCloudAuthResult> {
  signOutInProgress = true;
  try {
    return await performSignOut();
  } finally {
    signOutInProgress = false;
  }
}

async function performSignOut(): Promise<DeusCloudAuthResult> {
  loginGeneration += 1;
  const pending = pendingLogin;
  if (pending) {
    finishPendingLogin(new Error("Deus Cloud sign-in was cancelled"), undefined, pending);
  }

  // Revoke THIS device's platform key while the session can still authorize
  // it; local deletion inside also locks the device out even when offline.
  const sessionToken = await getStoredDeusCloudSessionToken().catch(() => null);
  await revokeDeviceKey(sessionToken).catch(() => {});

  await clearStoredSession();
  const session = await getDeusCloudSessionStatus();
  broadcastAuthChanged(session);
  return { success: true, session };
}

export async function startDeusCloudLogin(): Promise<DeusCloudAuthResult> {
  if (loginStartInProgress || pendingLogin) {
    throw new Error("Deus Cloud sign-in is already in progress");
  }

  loginStartInProgress = true;
  const cloudUrl = resolveDeusCloudUrl();
  const state = createDesktopState();
  const pkce = createDesktopPkcePair();
  const generation = loginGeneration;
  let callbackServer: DesktopCallbackServer;
  try {
    callbackServer = await createDesktopCallbackServer(state);
    if (generation !== loginGeneration) {
      await callbackServer.close();
      throw new Error("Deus Cloud sign-in was cancelled");
    }
  } catch (error) {
    loginStartInProgress = false;
    throw error;
  }

  let pending!: PendingLogin;
  const resultPromise = new Promise<DeusCloudAuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void callbackServer.close();
      if (pendingLogin === pending) {
        pendingLogin = null;
      }
      reject(new Error("Deus Cloud sign-in timed out"));
    }, LOGIN_TIMEOUT_MS);

    pending = {
      state,
      verifier: pkce.verifier,
      cloudUrl,
      closeCallbackServer: callbackServer.close,
      timeout,
      resolve,
      reject,
    };
    pendingLogin = pending;
  });
  loginStartInProgress = false;

  void (async () => {
    try {
      const config = await fetchDesktopAuthConfig(cloudUrl);
      if (pendingLogin !== pending) return;

      const loginUrl = buildDesktopLoginUrl({
        config,
        callbackPort: Number(new URL(callbackServer.redirectUri).port),
        state,
        codeChallenge: pkce.challenge,
      });
      if (pendingLogin !== pending) return;

      await shell.openExternal(loginUrl);
    } catch (error) {
      finishPendingLogin(
        error instanceof Error ? error : new Error("Could not open Deus Cloud"),
        undefined,
        pending
      );
    }
  })();

  void (async () => {
    try {
      const callback = await callbackServer.waitForCallback;
      await completeDesktopLogin(callback);
    } catch (error) {
      finishPendingLogin(
        error instanceof Error ? error : new Error("Deus Cloud sign-in failed"),
        undefined,
        pending
      );
    }
  })();

  return resultPromise;
}

async function completeDesktopLogin(callback: DesktopAuthCallback): Promise<void> {
  let activePending: PendingLogin | null = null;
  try {
    const pending = pendingLogin;
    if (!pending) {
      return;
    }
    activePending = pending;
    if (callback.state !== pending.state) {
      throw new Error("Deus Cloud sign-in state did not match");
    }

    const stored = await exchangeDesktopCode({
      cloudUrl: pending.cloudUrl,
      code: callback.code,
      verifier: pending.verifier,
    });
    if (pendingLogin !== pending) return;

    await writeStoredSession(stored);
    const session = await enrichWithCredentialStatus(toPublicStatus(stored));
    broadcastAuthChanged(session);
    finishPendingLogin(null, session, pending);

    // The D1 handshake: mint this device's platform key and hand credentials
    // to the backend, then re-broadcast so Settings flips to "key active".
    const provisionGeneration = loginGeneration;
    void (async () => {
      const token = await getStoredDeusCloudSessionToken();
      if (!token) return;
      await provisionAfterLogin(token, stored.cloudUrl);
      // Signing out mid-mint used to leave a freshly minted key in the vault
      // of a signed-out user: revokeDeviceKey ran BEFORE the key existed, so
      // nothing ever revoked it and the backend cloud lane stayed live.
      if (provisionGeneration !== loginGeneration) {
        // Use the CAPTURED token, not a re-read: sign-out has already cleared
        // the stored session by now, and revokeDeviceKey skips the server-side
        // DELETE when handed null — which would delete the local copy and
        // leave the just-minted key alive on the platform forever.
        await revokeDeviceKey(token).catch(() => {});
        return;
      }
      broadcastAuthChanged(await getDeusCloudSessionStatus());
    })();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Deus Cloud sign-in failed");
    finishPendingLogin(normalized, undefined, activePending ?? undefined);
    if (!activePending || pendingLogin !== activePending) {
      broadcastAuthChanged(await getDeusCloudSessionStatus());
    }
  }
}

export function registerDeusCloudAuthHandlers(): void {
  ipcMain.handle("deus_cloud:get_session", () => getDeusCloudSessionStatus());
  ipcMain.handle("deus_cloud:start_login", () => startDeusCloudLogin());
  ipcMain.handle("deus_cloud:sign_out", () => signOutDeusCloud());
  ipcMain.handle("deus_cloud:retry_provision", async () => {
    const result = await retryDeviceKeyProvisioning();
    broadcastAuthChanged(await getDeusCloudSessionStatus());
    return result;
  });
}
