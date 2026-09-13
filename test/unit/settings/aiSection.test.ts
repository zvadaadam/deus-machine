import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AISection } from "@/features/settings/ui/sections/AISection";
import type { AgentAuthStatus } from "@/features/settings/types";

const state = vi.hoisted(() => ({
  data: undefined as AgentAuthStatus | undefined,
  isError: false,
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...state, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("@/features/settings/ui/sections/ProviderAccounts", () => ({
  ProviderAccounts: () => null,
}));

beforeEach(() => {
  state.data = undefined;
  state.isError = false;
});

const render = () =>
  renderToStaticMarkup(
    createElement(AISection, {
      settings: {},
      saveSetting: async () => true,
    })
  );

describe("local agent status", () => {
  it("offers sign-in for a successful no-credentials Claude account", () => {
    state.data = {
      agents: [{ type: "claude-code", installed: true }],
      claude: {
        type: "claude_auth_output",
        agentHarness: "claude-code",
        accountInfo: { tokenSource: "none", apiProvider: "firstParty" },
      },
      codex: null,
    };
    const html = render();
    expect(html).toContain("Not connected");
    expect(html).toContain(">Sign in</button>");
  });

  it.each([
    { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" },
    { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" },
    { email: "member@example.com", orgName: "Example" },
  ])("keeps an authenticated Claude account connected: %j", (accountInfo) => {
    state.data = {
      agents: [{ type: "claude-code", installed: true }],
      claude: { type: "claude_auth_output", agentHarness: "claude-code", accountInfo },
      codex: null,
    };
    const html = render();
    expect(html).toContain(">Connected</span>");
    expect(html).not.toContain(">Sign in</button>");
    if ("email" in accountInfo) expect(html).toContain("member@example.com · Example");
  });

  it.each(["request", "envelope", "provider"])(
    "does not offer sign-in for a failed %s account probe",
    (failure) => {
      state.data = {
        agents: [{ type: "claude-code", installed: true }],
        claude: {
          type: "claude_auth_output",
          agentHarness: "claude-code",
          accountInfo: { email: "member@example.com" },
        },
        codex: null,
      };
      if (failure === "request") state.isError = true;
      if (failure === "envelope") state.data.error = "Agent server not connected";
      if (failure === "provider") state.data.claude!.error = "auth check timed out";
      const html = render();
      expect(html).toContain("Status unavailable");
      expect(html).toContain('aria-label="Refresh local provider status"');
      expect(html).not.toContain(">Sign in</button>");
      expect(html).not.toContain("member@example.com");
    }
  );

  it.each(["no response", "disconnected runtime", "failed refresh"])(
    "does not claim agents are missing after %s",
    (scenario) => {
      if (scenario === "disconnected runtime")
        state.data = { agents: [], claude: null, codex: null, error: "Agent server not connected" };
      if (scenario === "failed refresh") {
        state.data = { agents: [], claude: null, codex: null };
        state.isError = true;
      }
      const html = render();
      expect(html.match(/Status unavailable/g)).toHaveLength(2);
      expect(html).not.toContain("Not installed");
      expect(html).not.toContain(">Install<");
    }
  );

  it("shows installation actions only when the available runtime reports missing harnesses", () => {
    state.data = { agents: [], claude: null, codex: null };
    const html = render();
    expect(html.match(/Not installed/g)).toHaveLength(2);
    expect(html).not.toContain("Status unavailable");
  });

  it("keeps installed Codex login status owned by its CLI", () => {
    state.data = {
      agents: [{ type: "codex-app-server", installed: true }],
      claude: null,
      codex: null,
    };
    expect(render()).toContain("Login managed by Codex");
  });
});
