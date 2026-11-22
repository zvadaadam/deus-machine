import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAuth, HarnessCli } from "@shared/agent-auth";
import { api } from "@shared/api";
import { LOCAL_HARNESSES } from "@shared/harnesses";

const { call, page, openExternalPending, toast } = vi.hoisted(() => {
  const page = { open: vi.fn(async () => {}), cancel: vi.fn() };
  return {
    call: vi.fn(),
    page,
    openExternalPending: vi.fn(() => page),
    toast: { success: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@/platform/ws", () => ({ call }));
vi.mock("@/platform/native/window", () => ({ openExternalPending }));
vi.mock("sonner", () => ({ toast }));

import { LocalAgentRow } from "@/features/settings/ui/sections/LocalAgentRow";
import {
  installLocalAgent,
  readLocalAgent,
  signInLocalAgent,
} from "@/features/settings/lib/local-agent-login";

const browser = {
  id: "claudeai",
  kind: "browser",
  label: "Claude",
  credential: "subscription",
} as const;
const signedOut = {
  harness: "claude-code",
  state: "signed_out",
  methods: [browser],
} satisfies HarnessAuth;

// From agy's auth/status and clis/list. The account email and local install path are omitted.
const googleAccount: HarnessAuth = {
  harness: "gemini",
  state: "signed_in",
  credential: "subscription",
  source: "login",
  provider: "google",
  plan: "g1-pro-tier",
  label: "Google AI Pro",
  methods: [
    { id: "google", kind: "browser", label: "Google account", credential: "subscription" },
    {
      id: "terminal",
      kind: "terminal",
      label: "agy acp --login",
      command: ["agy", "acp", "--login"],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    },
  ],
};
const installed: HarnessCli = {
  harness: "gemini",
  state: "ready",
  version: "1.5.14",
  source: "cache",
};
const googleSignedOut = {
  harness: "gemini",
  state: "signed_out",
  methods: googleAccount.methods,
} satisfies HarnessAuth;

beforeEach(() => vi.clearAllMocks());

it.each(LOCAL_HARNESSES)("asks to install only %s when its row is pressed", async (harness) => {
  await installLocalAgent(harness);
  expect(call).toHaveBeenCalledExactlyOnceWith(api.agentPrepareClis, { harness });
});

describe("signInLocalAgent", () => {
  it("takes the tab during the click, and sends it to the sign-in page once the backend answers", async () => {
    let answer!: (result: unknown) => void;
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const signingIn = signInLocalAgent("claude-code", signedOut);
    // Before any answer: a browser allows the tab only now.
    expect(openExternalPending).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledExactlyOnceWith(
      api.agentSignIn,
      { harness: "claude-code", method: "claudeai" },
      { timeoutMs: 60_000 }
    );
    answer({ login: { loginId: "l1", url: "https://claude.ai/oauth" } });
    await signingIn;
    expect(page.open).toHaveBeenCalledWith("https://claude.ai/oauth");
    expect(page.cancel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "chatgpt",
      {
        ...signedOut,
        harness: "codex-app-server",
        methods: [{ ...browser, id: "chatgpt", label: "ChatGPT" }],
      },
    ],
    ["google", googleSignedOut],
  ] satisfies [string, HarnessAuth][])(
    "uses the subscription browser method %s",
    async (method, auth) => {
      call.mockResolvedValue({ login: { loginId: "login", url: "https://example.test/login" } });
      await signInLocalAgent(auth.harness, auth);
      expect(call).toHaveBeenCalledExactlyOnceWith(
        api.agentSignIn,
        { harness: auth.harness, method },
        { timeoutMs: 60_000 }
      );
    }
  );

  it("closes the tab when this computer is already signed in", async () => {
    call.mockResolvedValue({ already: { ...signedOut, state: "signed_in" } });
    await signInLocalAgent("claude-code", signedOut);
    expect(page.cancel).toHaveBeenCalledOnce();
    expect(page.open).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it("closes the tab and says why when the sign-in does not start", async () => {
    call.mockRejectedValue(new Error("Agent server not connected"));
    await signInLocalAgent("claude-code", signedOut);
    expect(page.cancel).toHaveBeenCalledOnce();
    expect(page.open).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Agent server not connected");
  });
});

describe("Gemini in Settings", () => {
  it.each([
    [{ harness: "gemini", state: "missing" }, googleSignedOut, ["Not installed", "Install"]],
    [
      {
        harness: "gemini",
        state: "installing",
        version: installed.version,
        receivedBytes: 45,
        totalBytes: 100,
      },
      googleSignedOut,
      ["Installing 1.5.14 · 45%"],
    ],
    [installed, googleSignedOut, ["Not connected", "Sign in"]],
    [installed, googleAccount, ["Connected", "Google AI Pro", "Sign out"]],
  ] satisfies [HarnessCli, HarnessAuth, string[]][])(
    "shows the CLI and login the engine reports (%j)",
    (cli, auth, labels) => {
      const state = readLocalAgent(
        { data: { clis: [cli], auth: [auth], logins: [] }, isLoading: false, isError: false },
        "gemini"
      );
      const html = renderToStaticMarkup(createElement(LocalAgentRow, { harness: "gemini", state }));
      for (const label of ["Gemini", "Google", ...labels]) expect(html).toContain(`>${label}<`);
    }
  );
});
