import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIToolsCheckStep } from "@/features/onboarding/ui/steps/AIToolsCheckStep";
import type { AgentAuthStatus } from "@/features/settings/types";

const auth = vi.hoisted(() => ({
  data: undefined as AgentAuthStatus | undefined,
  isLoading: false,
  isError: false,
}));
vi.mock("@/features/onboarding/api", () => ({
  useCliCheck: (tool: string) => ({
    data: { installed: tool === "claude" },
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...auth, refetch: vi.fn() }),
}));

beforeEach(() => {
  auth.isLoading = false;
  auth.isError = false;
  auth.data = {
    agents: [{ type: "claude-code", installed: true }],
    claude: {
      type: "claude_auth_output",
      agentHarness: "claude-code",
      accountInfo: { tokenSource: "none", apiProvider: "firstParty" },
    },
    codex: null,
  };
});

const render = () =>
  renderToStaticMarkup(createElement(AIToolsCheckStep, { onNext: vi.fn(), onBack: vi.fn() }));

describe("onboarding Claude account status", () => {
  it("offers sign-in for the SDK's successful no-credentials account object", () => {
    const html = render();
    expect(html).toContain("Sign in on this computer");
    expect(html).toContain(">Sign in</button>");
    expect(html).toContain(">Check again</button>");
  });

  it("offers sign-in when a successful probe has no account", () => {
    auth.data!.claude = null;
    expect(render()).toContain(">Sign in</button>");
  });

  it.each([
    { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" },
    { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" },
  ])("preserves signed-in token/API-key accounts: %j", (accountInfo) => {
    auth.data!.claude!.accountInfo = accountInfo;
    const html = render();
    expect(html).toContain("Signed in on this computer");
    expect(html).not.toContain(">Sign in</button>");
    expect(html).not.toContain(">Check again</button>");
  });

  it("preserves the signed-in account email", () => {
    auth.data!.claude!.accountInfo = { email: "member@example.com" };
    expect(render()).toContain("member@example.com");
  });

  it("waits for the account probe before offering an action", () => {
    auth.data = undefined;
    auth.isLoading = true;
    const html = render();
    expect(html).toContain("Checking account…");
    expect(html).not.toContain(">Sign in</button>");
    expect(html).not.toContain(">Check again</button>");
  });

  it.each(["request", "envelope", "provider"])(
    "offers another check after a %s failure, even with a cached account",
    (failure) => {
      auth.data!.claude!.accountInfo = { email: "member@example.com" };
      if (failure === "request") auth.isError = true;
      if (failure === "envelope") auth.data!.error = "Agent server not connected";
      if (failure === "provider") auth.data!.claude!.error = "auth check timed out";
      const html = render();
      expect(html).toContain("Couldn’t check account");
      expect(html).toContain(">Check again</button>");
      expect(html).not.toContain(">Sign in</button>");
      expect(html).not.toContain("member@example.com");
    }
  );
});
