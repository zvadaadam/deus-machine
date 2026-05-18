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
        config: {
          authorizationEndpoint: "https://api.workos.com/user_management/authorize",
          clientId: "client_test",
          provider: "authkit",
          redirectUri: "deus-machine://auth/callback",
        },
        codeChallenge: pair.challenge,
        state,
      })
    );

    expect(url.origin).toBe("https://api.workos.com");
    expect(url.pathname).toBe("/user_management/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_test");
    expect(url.searchParams.get("redirect_uri")).toBe("deus-machine://auth/callback");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("parses the desktop callback URL", () => {
    const parsed = parseDesktopAuthCallbackUrl(
      "deus-machine://auth/callback?code=oauth.code-1_~&state=state_1234567890123456"
    );

    expect(parsed).toEqual({
      code: "oauth.code-1_~",
      state: "state_1234567890123456",
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
