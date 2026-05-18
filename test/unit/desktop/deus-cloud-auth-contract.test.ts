import { describe, expect, it } from "vitest";
import {
  buildDesktopLoginUrl,
  createDesktopPkcePair,
  createDesktopState,
  isDesktopAuthCallbackUrl,
  parseDesktopAuthCallbackUrl,
  resolveDeusCloudUrl,
} from "../../../apps/desktop/main/deus-cloud-auth-contract";

describe("desktop Deus Cloud auth contract", () => {
  it("creates valid PKCE values for the desktop start endpoint", () => {
    const pair = createDesktopPkcePair();

    expect(pair.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  it("builds the Deus Cloud desktop login URL", () => {
    const pair = createDesktopPkcePair();
    const state = createDesktopState();
    const url = new URL(
      buildDesktopLoginUrl({
        cloudUrl: "https://cloud.deusmachine.ai",
        codeChallenge: pair.challenge,
        state,
      })
    );

    expect(url.origin).toBe("https://cloud.deusmachine.ai");
    expect(url.pathname).toBe("/auth/desktop/start");
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("parses the desktop callback URL", () => {
    const parsed = parseDesktopAuthCallbackUrl(
      "deus-machine://auth/callback?code=oauth.code-1_~&state=state_1234567890123456&expires_at=2026-05-18T15%3A00%3A00.000Z"
    );

    expect(parsed).toEqual({
      code: "oauth.code-1_~",
      state: "state_1234567890123456",
      expiresAt: "2026-05-18T15:00:00.000Z",
    });
  });

  it("rejects non-Deus callback URLs", () => {
    expect(isDesktopAuthCallbackUrl("https://cloud.deusmachine.ai/auth/callback")).toBe(false);
    expect(() =>
      parseDesktopAuthCallbackUrl("deus-machine://not-auth/callback?code=x&state=y")
    ).toThrow("Unsupported Deus Cloud callback URL");
  });

  it("resolves a configurable Deus Cloud base URL", () => {
    expect(resolveDeusCloudUrl({ DEUS_MACHINE_CLOUD_URL: "http://localhost:8788/" })).toBe(
      "http://localhost:8788"
    );
  });
});
