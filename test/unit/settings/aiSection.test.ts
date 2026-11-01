import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AISection } from "@/features/settings/ui/sections/AISection";
import type { AgentAuthAnswer, HarnessAuth, HarnessCli } from "@shared/agent-auth";

const state = vi.hoisted(() => ({
  data: undefined as AgentAuthAnswer | undefined,
  isError: false,
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...state, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useAgentAuthEvents: () => {},
}));
vi.mock("@/features/settings/ui/sections/ProviderAccounts", () => ({
  ProviderAccounts: () => null,
}));

const browser = { id: "claudeai", kind: "browser", label: "Claude", credential: "subscription" };
const claude = (auth: Partial<HarnessAuth>): HarnessAuth => ({
  harness: "claude-code",
  state: "signed_out",
  methods: [browser],
  ...auth,
});
const codex: HarnessAuth = {
  harness: "codex-app-server",
  state: "signed_in",
  credential: "subscription",
  source: "login",
  label: "ChatGPT Pro",
  email: "member@example.com",
  methods: [],
};

const ready: HarnessCli[] = [
  { harness: "claude-code", state: "ready", version: "0.3.288", source: "cache" },
  { harness: "codex-app-server", state: "ready", version: "0.160.0", source: "cache" },
];

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
  it("offers sign-in for a signed-out agent", () => {
    state.data = { auth: [claude({}), codex], clis: ready, logins: [] };
    const html = render();
    expect(html).toContain("Not connected");
    expect(html.match(/>Sign in<\/button>/g)).toHaveLength(1);
  });

  it("shows who a signed-in agent runs as, and signs out only its own login", () => {
    state.data = {
      auth: [claude({ state: "signed_in", source: "environment", label: "Claude API key" }), codex],
      clis: ready,
      logins: [],
    };
    const html = render();
    expect(html.match(/>Connected<\/span>/g)).toHaveLength(2);
    expect(html).toContain("ChatGPT Pro · member@example.com");
    expect(html).toContain("Claude API key");
    expect(html.match(/>Sign out<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain(">Sign in</button>");
  });

  it("shows a sign-in under way instead of starting another", () => {
    state.data = {
      auth: [claude({}), codex],
      clis: ready,
      logins: [
        {
          loginId: "login-1",
          harness: "claude-code",
          method: "claudeai",
          codeUrl: "https://claude.ai/oauth/code",
          expiresAt: 1,
        },
      ],
    };
    const html = render();
    expect(html).toContain("Waiting for sign-in…");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain("Paste the code the sign-in page shows");
    expect(html).not.toContain(">Sign in</button>");
  });

  it("shows a CLI the engine is installing, and offers to install a missing one", () => {
    state.data = {
      auth: [claude({ state: "unknown" }), codex],
      clis: [
        {
          harness: "claude-code",
          state: "installing",
          version: "0.3.288",
          receivedBytes: 45,
          totalBytes: 100,
        },
        { harness: "codex-app-server", state: "missing" },
      ],
      logins: [],
    };
    const html = render();
    expect(html).toContain("Installing 0.3.288 · 45%");
    expect(html).toContain("Not installed");
    expect(html.match(/>Install<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain(">Sign in</button>");
  });

  it.each(["request", "envelope", "unknown"])(
    "does not offer sign-in when the login read failed (%s)",
    (failure) => {
      state.data = { auth: [claude({}), codex], clis: ready, logins: [] };
      if (failure === "request") state.isError = true;
      if (failure === "envelope") state.data.error = "Agent server not connected";
      if (failure === "unknown")
        state.data.auth[0] = claude({ state: "unknown", error: "timed out" });
      const html = render();
      expect(html).toContain("Status unavailable");
      expect(html).toContain('aria-label="Refresh local provider status"');
      expect(html).not.toContain(">Sign in</button>");
    }
  );
});
