import type { AgentAuthStatus, AgentProviderAuth } from "../types";

export type LocalProviderAuthState =
  | { status: "checking" | "failed" | "signed-out" }
  | { status: "signed-in"; accountInfo: NonNullable<AgentProviderAuth["accountInfo"]> };

/** A failed account probe is unknown; a successful no-credentials result is signed out. */
export function readLocalProviderAuth(
  query: { data?: AgentAuthStatus; isLoading: boolean; isError: boolean },
  provider: "claude" | "codex"
): LocalProviderAuthState {
  if (query.isLoading) return { status: "checking" };
  const auth = query.data?.[provider];
  if (query.isError || !query.data || query.data.error || auth?.error) {
    return { status: "failed" };
  }

  const accountInfo = auth?.accountInfo;
  // The SDK returns an account object even with no credentials. An API key
  // can still be active when tokenSource is "none".
  const hasApiKey = Boolean(accountInfo?.apiKeySource && accountInfo.apiKeySource !== "none");
  if (!accountInfo || (accountInfo.tokenSource === "none" && !hasApiKey)) {
    return { status: "signed-out" };
  }
  return { status: "signed-in", accountInfo };
}
