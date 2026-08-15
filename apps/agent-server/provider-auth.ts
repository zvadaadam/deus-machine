// agent-server/provider-auth.ts
// Provider auth status for the settings screen: spawn an idle SDK query and
// ask it for the account info, then interrupt it. Claude-only — the codex
// harnesses report "unsupported". Served over the deus/provider-auth side
// channel (the standard wire has no auth concept).

export async function providerAuth(params: unknown): Promise<unknown> {
  const { agentHarness, cwd } = (params ?? {}) as { agentHarness?: string; cwd?: string };
  if (!agentHarness || !cwd) throw new Error("provider-auth requires agentHarness and cwd");

  // "claude-code" is the harness id, the engine's and the settings route's
  // alike — deus keeps no alias map. The legacy "claude" spelling is gone from
  // every caller, so matching it here only made the settings screen report
  // "unsupported" (rendered as not-connected) for the one harness that IS
  // supported.
  if (agentHarness !== "claude-code") {
    return { type: "claude_auth_output", agentHarness, error: "unsupported" };
  }
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const emptyPrompt = (async function* () {})();
    const query = sdk.query({
      prompt: emptyPrompt,
      options: {
        cwd,
        // Packaged apps exclude the SDK's platform CLI packages — point the
        // SDK at the bundled binary (set by bundled-clis.ts); dev falls back
        // to the SDK's own resolution.
        ...(process.env.CLAUDE_CLI_PATH
          ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH }
          : {}),
      },
    });
    try {
      // Bounded: a stalled CLI init must not hang the settings route (and
      // the finally-interrupt below reaps the subprocess either way).
      const accountInfo = await Promise.race([
        query.accountInfo(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("auth check timed out")), 15_000)
        ),
      ]);
      return { type: "claude_auth_output", agentHarness: "claude-code", accountInfo };
    } finally {
      void query.interrupt().catch(() => {});
    }
  } catch (error) {
    return {
      type: "claude_auth_output",
      agentHarness: "claude-code",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
