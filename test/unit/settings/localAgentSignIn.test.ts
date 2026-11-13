import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAuth } from "@shared/agent-auth";
import { api } from "@shared/api";

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

import { signInLocalAgent } from "@/features/settings/lib/local-agent-login";

const browser = { id: "claudeai", kind: "browser", label: "Claude", credential: "subscription" };
const signedOut = {
  harness: "claude-code",
  state: "signed_out",
  methods: [browser],
} as HarnessAuth;

beforeEach(() => vi.clearAllMocks());

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
