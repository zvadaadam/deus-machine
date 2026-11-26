import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AISection } from "@/features/settings/ui/sections/AISection";
import type { AgentAuthAnswer, HarnessAuth, HarnessCli } from "@shared/agent-auth";

const state = vi.hoisted(() => ({
  data: undefined as AgentAuthAnswer | undefined,
  isError: false,
  remote: false,
  isFetching: false,
}));
vi.mock("@/assets/agents/cliproxyapi.svg?react", () => ({ default: () => null }));
vi.mock("@/assets/agents", () => ({ getAgentLogo: () => null }));
vi.mock("@/shared/hooks/useGateways", () => ({ useGateways: () => ({ data: [] }) }));
vi.mock("@/platform/ws/device-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  needsRemoteAuth: () => state.remote,
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...state, isLoading: false, refetch: vi.fn() }),
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
  state.remote = false;
  state.isFetching = false;
});

const render = () =>
  renderToStaticMarkup(
    createElement(AISection, {
      settings: {},
      saveSetting: async () => true,
    })
  );

describe("local agent status", () => {
  it("offers automatic continuation for local chats and defaults it off", () => {
    const label = "Continue after a usage limit";
    for (const on of [undefined, true]) {
      const props = { settings: { continue_after_usage_limit: on }, saveSetting: vi.fn() };
      const html = renderToStaticMarkup(createElement(AISection, props));
      expect(html).toContain(label);
      expect(html).toContain(`aria-checked="${on === true}"`);
      expect(
        renderToStaticMarkup(createElement(AISection, { ...props, cloudOnly: true }))
      ).not.toContain(label);
    }
  });

  it("labels an unconfigured gateway, explains agent messages and spins the disabled refresh during a read", () => {
    state.isFetching = true;
    const html = render();
    expect(html).toContain("No gateways connected");
    expect(html).toContain("Agents send you updates while they work.");
    expect(
      html.match(
        /<button[^>]*aria-label="Refresh local provider status"[^>]*>[\s\S]*?<\/button>/
      )?.[0]
    ).toEqual(expect.stringMatching(/disabled=""[\s\S]*lucide-loader/));
  });

  it("offers sign-in for a signed-out agent", () => {
    state.data = { auth: [claude({}), codex], clis: ready, logins: [] };
    const html = render();
    expect(html.match(/>Not signed in</g)).toHaveLength(1);
    expect(html).toContain("Anthropic");
    expect(html.match(/>Sign in<\/button>/g)).toHaveLength(1);
  });

  it("shows who a signed-in agent runs as, and signs out only its own login", () => {
    state.data = {
      auth: [
        claude({
          state: "signed_in",
          source: "environment",
          credential: "api_key",
          label: "Claude API key",
        }),
        codex,
      ],
      clis: ready,
      logins: [],
    };
    const html = render();
    expect(html.match(/>Signed in<\/span>/g)).toHaveLength(2);
    expect(html).toContain("ChatGPT Pro · member@example.com");
    expect(html).toContain("Claude API key · environment");
    expect(html).toContain('aria-label="Codex options"');
    expect(html).not.toContain('aria-label="Claude Code options"');
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
    expect(html).not.toContain("Not signed in");
    expect(html).toContain('aria-label="Claude Code options"');
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
        { harness: "gemini", state: "missing", version: "1.5.14" },
      ],
      logins: [],
    };
    const html = render();
    expect(html).toContain("Installing 0.3.288 · 45%");
    expect(html).toContain(">Not available on this computer<");
    expect(html).toContain(">Installs on first use<");
    expect(html.match(/>Install<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain(">Sign in</button>");
  });

  it.each(["request", "envelope", "unknown"])(
    "does not offer sign-in when the login read failed (%s)",
    (failure) => {
      state.data = { auth: [claude({}), codex], clis: ready, logins: [] };
      if (failure === "request") state.isError = true;
      if (failure === "envelope") state.data.error = "Agent server is disconnected";
      if (failure === "unknown")
        state.data.auth[0] = claude({ state: "unknown", error: "timed out" });
      const html = render();
      expect(html).toContain("Unavailable");
      if (failure === "envelope") expect(html).toContain("Agent server is disconnected");
      if (failure === "unknown") expect(html).toContain("timed out");
      expect(html).toContain('aria-label="Refresh local provider status"');
      expect(html).not.toContain(">Sign in</button>");
    }
  );
});

it("checks Agent messages by default and honours a saved choice", () => {
  for (const [saved, checked] of [
    [undefined, true],
    [false, false],
    [true, true],
  ] as const) {
    const settings = { agent_messages: saved };
    const html = renderToStaticMarkup(createElement(AISection, { settings, saveSetting: vi.fn() }));
    const toggle = html.match(/<button\b[^>]*\bid="agent-messages"[^>]*>/)?.[0];
    expect(toggle).toContain(`aria-checked="${checked}"`);
  }
});

it("makes the connected catalog count an expandable button and keeps connection options separate", async () => {
  const { GatewaysSection } = await import("@/features/settings/ui/sections/GatewaysSection");
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(GatewaysSection, {
        gateways: [
          {
            ref: "original",
            preset: "cliproxyapi",
            formats: ["responses"],
            generation: "gen",
            address: "http://localhost",
            models: [{ id: "x", provider: "openai" }],
          },
        ],
        local: true,
        checking: false,
        recheck: vi.fn(),
      })
    )
  );
  expect(html).toContain(
    "Safest with API keys. If you sign a personal subscription into the proxy, or switch between accounts to get past a limit, the provider can suspend that account."
  );
  expect(html).toContain("No chat models");
  expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?1 model[\s\S]*?<\/button>/);
});

it("offers the gateway presets on this computer", () => {
  expect(render()).toContain('aria-label="Gateways"');
  expect(render()).toContain(">Add gateway<");
  state.remote = true;
  expect(render()).not.toContain(">Add gateway<");
  expect(render()).toContain("Manage gateways on this computer.");
});
