import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "../../../shared/types";
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
  tokenType: "Bearer";
  expiresAt: string;
  encryptedSessionToken: string;
  cloudUrl: string;
  createdAt: string;
}

interface DesktopExchangeResponse {
  session_token?: string;
  token_type?: string;
  expires_in_seconds?: number;
  account_id?: string;
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

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getSessionFilePath(): string {
  return join(app.getPath("userData"), SESSION_FILE_NAME);
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
    };
  }

  return {
    signedIn: true,
    accountId: stored.accountId,
    expiresAt: stored.expiresAt,
    tokenType: stored.tokenType,
    cloudUrl: stored.cloudUrl,
  };
}

function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device");
  }
}

function respondHtml(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html><title>Deus</title><body>${message}</body>`);
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
      respondHtml(res, 409, "This Deus sign-in request was already handled.");
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
      respondHtml(res, 200, "You can return to Deus.");
      resolveCallback(callback);
    } catch (error) {
      settled = true;
      respondHtml(res, 400, "Deus sign-in failed.");
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

async function readStoredSession(): Promise<StoredDeusCloudSession | null> {
  try {
    const raw = await readFile(getSessionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredDeusCloudSession>;
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

    const expiresAt = parseTimestamp(parsed.expiresAt);
    if (!expiresAt || expiresAt <= Date.now()) {
      await clearStoredSession();
      return null;
    }

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

async function writeStoredSession(session: StoredDeusCloudSession): Promise<void> {
  const filePath = getSessionFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function clearStoredSession(): Promise<void> {
  await rm(getSessionFilePath(), { force: true });
}

function encryptSessionToken(token: string): string {
  requireSafeStorage();
  return safeStorage.encryptString(token).toString("base64");
}

function decryptSessionToken(encryptedToken: string): string {
  requireSafeStorage();
  return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
}

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
  const response = await fetch(new URL("/auth/desktop/config", cloudUrl));
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
  const response = await fetch(new URL("/auth/desktop/exchange", input.cloudUrl), {
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
    body.token_type !== "Bearer" ||
    typeof body.account_id !== "string" ||
    typeof body.expires_in_seconds !== "number"
  ) {
    throw new Error("Deus Cloud returned an invalid desktop session");
  }

  return {
    version: SESSION_FILE_VERSION,
    accountId: body.account_id,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + body.expires_in_seconds * 1000).toISOString(),
    encryptedSessionToken: encryptSessionToken(body.session_token),
    cloudUrl: input.cloudUrl,
    createdAt: new Date().toISOString(),
  };
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
  return toPublicStatus(await readStoredSession());
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
  let callbackServer: DesktopCallbackServer;
  try {
    callbackServer = await createDesktopCallbackServer(state);
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
    const session = toPublicStatus(stored);
    broadcastAuthChanged(session);
    finishPendingLogin(null, session, pending);
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
}
