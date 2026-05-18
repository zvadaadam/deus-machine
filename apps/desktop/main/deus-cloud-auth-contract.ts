import { createHash, randomBytes } from "node:crypto";

export const DEUS_CLOUD_DEFAULT_URL = "https://cloud.deusmachine.ai";
export const DEUS_CLOUD_DESKTOP_CALLBACK_HOST = "127.0.0.1";
export const DEUS_CLOUD_DESKTOP_CALLBACK_PATH = "/auth/callback";

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const WORKOS_AUTH_CODE_RE = /^[!-~]{1,2048}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{16,128}$/;
const LOOPBACK_REDIRECT_PATTERN_RE = /^http:\/\/127\.0\.0\.1:\*\/auth\/callback$/;

export interface DesktopPkcePair {
  verifier: string;
  challenge: string;
}

export interface DesktopAuthConfig {
  authorizationEndpoint: string;
  clientId: string;
  provider: "authkit";
  redirectUri: string;
}

export interface DesktopAuthCallback {
  code: string;
  state: string;
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

export function resolveDesktopRedirectUri(pattern: string, port: number): string {
  if (!LOOPBACK_REDIRECT_PATTERN_RE.test(pattern)) {
    throw new Error("Invalid desktop redirect URI pattern");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid desktop callback port");
  }

  return `http://${DEUS_CLOUD_DESKTOP_CALLBACK_HOST}:${port}${DEUS_CLOUD_DESKTOP_CALLBACK_PATH}`;
}

export function isDesktopRedirectUri(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      url.hostname === DEUS_CLOUD_DESKTOP_CALLBACK_HOST &&
      url.pathname === DEUS_CLOUD_DESKTOP_CALLBACK_PATH &&
      url.port.length > 0
    );
  } catch {
    return false;
  }
}

export function buildDesktopLoginUrl(input: {
  config: DesktopAuthConfig;
  callbackPort: number;
  codeChallenge: string;
  state: string;
}): string {
  if (!PKCE_CHALLENGE_RE.test(input.codeChallenge)) {
    throw new Error("Invalid desktop code challenge");
  }
  if (!STATE_RE.test(input.state)) {
    throw new Error("Invalid desktop auth state");
  }

  const url = new URL(input.config.authorizationEndpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Invalid WorkOS authorization endpoint");
  }
  if (!input.config.clientId) {
    throw new Error("Invalid WorkOS client ID");
  }
  const redirectUri = resolveDesktopRedirectUri(input.config.redirectUri, input.callbackPort);
  if (!isDesktopRedirectUri(redirectUri)) {
    throw new Error("Invalid desktop redirect URI");
  }

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("provider", input.config.provider);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function parseDesktopAuthCallbackUrl(rawUrl: string): DesktopAuthCallback {
  if (!isDesktopRedirectUri(rawUrl)) {
    throw new Error("Unsupported Deus Cloud callback URL");
  }

  const url = new URL(rawUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !WORKOS_AUTH_CODE_RE.test(code)) {
    throw new Error("Invalid WorkOS authorization code");
  }
  if (!state || !STATE_RE.test(state)) {
    throw new Error("Invalid desktop auth state");
  }

  return { code, state };
}
