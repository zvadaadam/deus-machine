import { createHash, randomBytes } from "node:crypto";

export const DEUS_CLOUD_DEFAULT_URL = "https://cloud.deusmachine.ai";
export const DEUS_CLOUD_PROTOCOL = "deus-machine";
export const DEUS_CLOUD_AUTH_CALLBACK_HOST = "auth";
export const DEUS_CLOUD_AUTH_CALLBACK_PATH = "/callback";

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{16,128}$/;

export interface DesktopPkcePair {
  verifier: string;
  challenge: string;
}

export interface DesktopAuthCallback {
  code: string;
  state: string;
  expiresAt: string | null;
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function createDesktopPkcePair(): DesktopPkcePair {
  const verifier = base64UrlEncode(randomBytes(48));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createDesktopState(): string {
  return base64UrlEncode(randomBytes(32));
}

export function assertDesktopPkcePair(pair: DesktopPkcePair): void {
  if (!PKCE_VERIFIER_RE.test(pair.verifier)) {
    throw new Error("Generated PKCE verifier is invalid");
  }
  if (!PKCE_CHALLENGE_RE.test(pair.challenge)) {
    throw new Error("Generated PKCE challenge is invalid");
  }
}

export function resolveDeusCloudUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.DEUS_MACHINE_CLOUD_URL ||
    env.DEUS_CLOUD_URL ||
    env.VITE_DEUS_CLOUD_URL ||
    DEUS_CLOUD_DEFAULT_URL;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Deus Cloud URL must use http or https");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

export function buildDesktopLoginUrl(input: {
  cloudUrl: string;
  codeChallenge: string;
  state: string;
}): string {
  if (!PKCE_CHALLENGE_RE.test(input.codeChallenge)) {
    throw new Error("Invalid desktop code challenge");
  }
  if (!STATE_RE.test(input.state)) {
    throw new Error("Invalid desktop auth state");
  }

  const url = new URL("/auth/desktop/start", input.cloudUrl);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function isDesktopAuthCallbackUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === `${DEUS_CLOUD_PROTOCOL}:` &&
      url.hostname === DEUS_CLOUD_AUTH_CALLBACK_HOST &&
      url.pathname === DEUS_CLOUD_AUTH_CALLBACK_PATH
    );
  } catch {
    return false;
  }
}

export function parseDesktopAuthCallbackUrl(rawUrl: string): DesktopAuthCallback {
  if (!isDesktopAuthCallbackUrl(rawUrl)) {
    throw new Error("Unsupported Deus Cloud callback URL");
  }

  const url = new URL(rawUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expiresAt = url.searchParams.get("expires_at");

  if (!code || !PKCE_CHALLENGE_RE.test(code)) {
    throw new Error("Invalid desktop login code");
  }
  if (!state || !STATE_RE.test(state)) {
    throw new Error("Invalid desktop auth state");
  }

  return { code, state, expiresAt };
}
