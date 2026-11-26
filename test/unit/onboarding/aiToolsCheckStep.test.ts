import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIToolsCheckStep } from "@/features/onboarding/ui/steps/AIToolsCheckStep";
import type { AgentAuthAnswer, HarnessAuth, HarnessCli } from "@shared/agent-auth";

const auth = vi.hoisted(() => ({
  data: undefined as AgentAuthAnswer | undefined,
  isFetching: false,
  isError: false,
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...auth, refetch: vi.fn() }),
}));

const browser = { id: "claudeai", kind: "browser", label: "Claude", credential: "subscription" };
const claude = (overrides: Partial<HarnessAuth> = {}): HarnessAuth => ({
  harness: "claude-code",
  state: "signed_out",
  methods: [browser],
  ...overrides,
});

const clis: HarnessCli[] = [
  { harness: "claude-code", state: "ready", version: "0.3.288", source: "cache" },
  { harness: "codex-app-server", state: "missing" },
  { harness: "gemini", state: "missing", version: "1.5.14" },
];

beforeEach(() => {
  auth.isFetching = false;
  auth.isError = false;
  auth.data = { auth: [claude()], clis, logins: [] };
});

const render = () =>
  renderToStaticMarkup(createElement(AIToolsCheckStep, { onNext: vi.fn(), onBack: vi.fn() }));

describe("onboarding Claude account status", () => {
  it("offers sign-in for a signed-out Claude", () => {
    const html = render();
    expect(html).toContain("Sign in on this computer");
    expect(html).toContain(">Sign in</button>");
    expect(html).toContain(">Check again</button>");
  });

  it("shows who a signed-in Claude runs as, whatever signed it in", () => {
    auth.data = {
      auth: [
        claude({
          state: "signed_in",
          source: "environment",
          label: "Claude Max",
          email: "member@example.com",
        }),
      ],
      clis,
      logins: [],
    };
    const html = render();
    expect(html).toContain("Claude Max · member@example.com");
    expect(html).not.toContain(">Sign in</button>");
    expect(html).not.toContain(">Check again</button>");
  });

  it("shows a sign-in under way rather than offering another", () => {
    auth.data!.logins = [
      {
        loginId: "login-1",
        harness: "claude-code",
        method: "claudeai",
        url: "https://claude.ai/oauth",
        expiresAt: 1,
      },
    ];
    const html = render();
    expect(html).toContain("Waiting for sign-in…");
    expect(html).not.toContain(">Sign in</button>");
  });

  it("takes the code a sign-in page shows, to finish a sign-in from onboarding", () => {
    auth.data!.logins = [
      {
        loginId: "login-1",
        harness: "claude-code",
        method: "claudeai",
        codeUrl: "https://claude.ai/oauth/code",
        expiresAt: 1,
      },
    ];
    const html = render();
    expect(html).toContain("Waiting for sign-in…");
    expect(html).toContain("Paste the code the sign-in page shows");
  });

  it("offers Install only for a CLI the engine can install", () => {
    const html = render();
    expect(html).toContain(">Gemini</p>");
    expect(html).toContain(">Not available on this computer<");
    expect(html).toContain(">Installs on first use<");
    expect(html.match(/>Install<\/button>/g)).toHaveLength(1);
  });

  it("offers Try again for a failed install with a version and shows the reason for an unavailable CLI", () => {
    auth.data!.clis = [
      clis[0]!,
      { harness: "gemini", state: "failed", version: "1.5.14", error: "Download failed" },
      { harness: "codex-app-server", state: "failed", error: "Codex is unavailable" },
    ];
    const html = render();
    expect(html.match(/>Try again<\/button>/g)).toHaveLength(1);
    expect(html).toContain("its install failed: Download failed");
    expect(html).toContain(">Codex is unavailable<");
  });

  it("waits for the login read before offering an action", () => {
    auth.data = undefined;
    auth.isFetching = true;
    const html = render();
    expect(html).toContain("Checking…");
    expect(html).not.toContain(">Sign in</button>");
    expect(html).not.toContain(">Check again</button>");
  });

  it.each(["request", "envelope", "unknown", "missing CLI row"])(
    "offers another check after a %s failure, even with a cached login",
    (failure) => {
      auth.data = {
        auth: [claude({ state: "signed_in", email: "member@example.com" })],
        clis,
        logins: [],
      };
      if (failure === "request") auth.isError = true;
      if (failure === "envelope") auth.data.error = "Agent server is disconnected";
      if (failure === "unknown") auth.data.auth[0] = claude({ state: "unknown" });
      if (failure === "missing CLI row") {
        auth.data.clis = clis.filter((cli) => cli.harness !== "claude-code");
      }
      const html = render();
      expect(html.match(/aria-label="Status could not be read"/g)).toHaveLength(
        failure === "request" || failure === "envelope" ? clis.length : 1
      );
      expect(html).toContain("Couldn’t check account");
      expect(html).toContain(">Check again</button>");
      expect(html).not.toContain(">Sign in</button>");
      expect(html).not.toContain("member@example.com");
    }
  );
});
