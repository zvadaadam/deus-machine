import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "../../../shared/types";
import {
  buildDesktopLoginUrl,
  createDesktopPkcePair,
  createDesktopState,
  DEUS_CLOUD_PROTOCOL,
  isDesktopAuthCallbackUrl,
  parseDesktopAuthCallbackUrl,
  resolveDeusCloudUrl,
} from "./deus-cloud-auth-contract";

export { isDesktopAuthCallbackUrl };

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

interface PendingLogin {
  state: string;
  verifier: string;
  cloudUrl: string;
  timeout: NodeJS.Timeout;
  resolve: (value: DeusCloudAuthResult) => void;
  reject: (error: Error) => void;
}

let pendingLogin: PendingLogin | null = null;

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

function finishPendingLogin(error: Error | null, status?: DeusCloudSessionStatus): void {
  const pending = pendingLogin;
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingLogin = null;

  if (error) {
    pending.reject(error);
    return;
  }

  pending.resolve({
    success: true,
    session: status ?? toPublicStatus(null, pending.cloudUrl),
  });
}

export function registerDeusCloudProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEUS_CLOUD_PROTOCOL, process.execPath, [process.argv[1]]);
    return;
  }

  app.setAsDefaultProtocolClient(DEUS_CLOUD_PROTOCOL);
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
  if (pendingLogin) {
    throw new Error("Deus Cloud sign-in is already in progress");
  }

  const cloudUrl = resolveDeusCloudUrl();
  const state = createDesktopState();
  const pkce = createDesktopPkcePair();
  const loginUrl = buildDesktopLoginUrl({
    cloudUrl,
    state,
    codeChallenge: pkce.challenge,
  });

  const resultPromise = new Promise<DeusCloudAuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingLogin = null;
      reject(new Error("Deus Cloud sign-in timed out"));
    }, LOGIN_TIMEOUT_MS);

    pendingLogin = {
      state,
      verifier: pkce.verifier,
      cloudUrl,
      timeout,
      resolve,
      reject,
    };
  });

  try {
    await shell.openExternal(loginUrl);
  } catch (error) {
    finishPendingLogin(error instanceof Error ? error : new Error("Could not open Deus Cloud"));
  }

  return resultPromise;
}

export async function handleDeusCloudAuthCallbackUrl(rawUrl: string): Promise<boolean> {
  if (!isDesktopAuthCallbackUrl(rawUrl)) return false;

  try {
    const callback = parseDesktopAuthCallbackUrl(rawUrl);
    const pending = pendingLogin;
    if (!pending) {
      throw new Error("No Deus Cloud sign-in is in progress");
    }
    if (callback.state !== pending.state) {
      throw new Error("Deus Cloud sign-in state did not match");
    }
    if (callback.expiresAt) {
      const expiresAt = parseTimestamp(callback.expiresAt);
      if (!expiresAt || expiresAt <= Date.now()) {
        throw new Error("Deus Cloud sign-in code expired");
      }
    }

    const stored = await exchangeDesktopCode({
      cloudUrl: pending.cloudUrl,
      code: callback.code,
      verifier: pending.verifier,
    });
    await writeStoredSession(stored);
    const session = toPublicStatus(stored);
    broadcastAuthChanged(session);
    finishPendingLogin(null, session);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Deus Cloud sign-in failed");
    finishPendingLogin(normalized);
    broadcastAuthChanged(await getDeusCloudSessionStatus());
  }

  return true;
}

export function handlePotentialDeusCloudAuthUrls(values: readonly string[]): boolean {
  let handled = false;
  for (const value of values) {
    if (isDesktopAuthCallbackUrl(value)) {
      handled = true;
      void handleDeusCloudAuthCallbackUrl(value);
    }
  }
  return handled;
}

export function registerDeusCloudAuthHandlers(): void {
  ipcMain.handle("deus_cloud:get_session", () => getDeusCloudSessionStatus());
  ipcMain.handle("deus_cloud:start_login", () => startDeusCloudLogin());
  ipcMain.handle("deus_cloud:sign_out", () => signOutDeusCloud());
}
