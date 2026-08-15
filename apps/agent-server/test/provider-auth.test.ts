/**
 * provider-auth harness gating.
 *
 * The failure this pins was invisible from both ends: the settings route asks
 * for `claude-code` (the engine's harness id, and the one the handshake
 * advertises), while this module still matched the pre-engine spelling
 * `claude`. Every check therefore fell through to `unsupported`, which the
 * settings screen renders as "not connected" — for a signed-in user, with a
 * working harness, and nothing in the logs.
 *
 * The only coverage was in the opt-in e2e suite, which is skipped without a
 * real Claude CLI, so CI never saw it. These cases need no SDK: the harness id
 * is decided before any import of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK is a system boundary here: letting the real one run would spawn the
// Claude CLI, making the suite slow and dependent on whether this machine has
// a CLI and a signed-in account.
const { mockQuery, mockInterrupt } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockInterrupt: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { providerAuth } from "../provider-auth";

const CWD = "/tmp";

beforeEach(() => {
  mockInterrupt.mockResolvedValue(undefined);
  mockQuery.mockReturnValue({
    accountInfo: vi.fn().mockResolvedValue({ email: "user@example.com" }),
    interrupt: mockInterrupt,
  });
});

describe("providerAuth", () => {
  it("requires both agentHarness and cwd", async () => {
    await expect(providerAuth({})).rejects.toThrow(/agentHarness and cwd/);
    await expect(providerAuth({ agentHarness: "claude-code" })).rejects.toThrow(
      /agentHarness and cwd/
    );
    await expect(providerAuth({ cwd: CWD })).rejects.toThrow(/agentHarness and cwd/);
  });

  it.each(["codex-sdk", "codex-app-server"])("reports %s as unsupported", async (agentHarness) => {
    // Auth introspection is a Claude SDK feature (accountInfo); codex has none.
    await expect(providerAuth({ agentHarness, cwd: CWD })).resolves.toMatchObject({
      agentHarness,
      error: "unsupported",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("checks auth for the canonical claude-code harness id", async () => {
    // The whole bug in one test: this is the id the settings route sends.
    await expect(providerAuth({ agentHarness: "claude-code", cwd: CWD })).resolves.toEqual({
      type: "claude_auth_output",
      agentHarness: "claude-code",
      accountInfo: { email: "user@example.com" },
    });
    expect(mockQuery).toHaveBeenCalledOnce();
    // The idle query exists only to be asked a question — reap it either way.
    expect(mockInterrupt).toHaveBeenCalledOnce();
  });

  it("reports an SDK failure under the canonical id, still not as unsupported", async () => {
    mockQuery.mockReturnValue({
      accountInfo: vi.fn().mockRejectedValue(new Error("not logged in")),
      interrupt: mockInterrupt,
    });

    await expect(providerAuth({ agentHarness: "claude-code", cwd: CWD })).resolves.toEqual({
      type: "claude_auth_output",
      agentHarness: "claude-code",
      error: "not logged in",
    });
  });

  it("no longer answers to the retired 'claude' spelling", async () => {
    // Nothing sends it any more, and keeping it alive alongside the canonical
    // id is how the two drifted apart in the first place.
    await expect(providerAuth({ agentHarness: "claude", cwd: CWD })).resolves.toMatchObject({
      error: "unsupported",
    });
  });
});
