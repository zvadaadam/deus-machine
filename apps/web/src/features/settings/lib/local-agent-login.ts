import { toast } from "sonner";
import type { AgentAuthAnswer, HarnessAuth } from "@shared/agent-auth";
import { agentReadiness } from "@shared/agent-readiness";
import type { AgentHarness } from "@shared/enums";
import { api } from "@shared/api";
import { openExternalPending } from "@/platform/native/window";
import { call } from "@/platform/ws";
import { finishAgentInstall, requestedAgentInstalls } from "./local-agent-installs";

export type LocalAgentState = ReturnType<typeof readLocalAgent>;

/** "Claude Max · you@example.com". */
export function accountLine(auth: HarnessAuth): string {
  return [auth.label, auth.email, auth.organization].filter(Boolean).join(" · ") || "Signed in";
}

/** An unknown login, or one the read could not get, is not a signed-out one. */
export function readLocalAgent(
  query: { data?: AgentAuthAnswer; isFetching: boolean; isError: boolean },
  harness: AgentHarness
) {
  const pending = { status: query.isFetching ? "checking" : "failed" } as const;
  if (query.isError || !query.data || query.data.error !== undefined) return pending;
  const agent = agentReadiness(query.data, harness);
  switch (agent.state) {
    case "ready":
      return { status: "signed-in", auth: agent.auth, account: accountLine(agent.auth) } as const;
    case "signed_out": {
      const login = query.data.logins.find((row) => row.harness === harness);
      return { status: "signed-out", auth: agent.auth, login } as const;
    }
    case "not_installed":
      return { status: "not-installed", detail: agent.detail } as const;
    case "unknown":
      return agent.status === "failed" && query.isFetching ? pending : agent;
  }
}

/** Why a request was refused or failed, for a toast. */
function reasonOf(error: unknown, otherwise: string): string {
  return (error instanceof Error && error.message) || otherwise;
}

export function installLabel(state: LocalAgentState) {
  if (state.status === "first-turn") return "Install";
  return state.status === "install-failed" ? "Try again" : undefined;
}

/** Install the selected agent's CLI. */
export async function installLocalAgent(harness: AgentHarness): Promise<void> {
  requestedAgentInstalls.add(harness);
  try {
    await call(api.agentPrepareClis, { harness });
  } catch (error) {
    finishAgentInstall(harness, reasonOf(error, "Couldn’t start the install"));
  }
}

/** The sign-in Deus offers: the subscription's own, in the browser. */
function browserSignIn(auth: HarnessAuth) {
  return auth.methods.find(
    (method) => method.kind === "browser" && method.credential === "subscription"
  );
}

export function localSignIn(state: LocalAgentState) {
  if (state.status !== "signed-out") return undefined;
  const { auth, login } = state;
  if (login?.codeUrl && !login.url) return { kind: "code", loginId: login.loginId } as const;
  if (!login && browserSignIn(auth)) return { kind: "start", auth } as const;
  return undefined;
}

/**
 * Sign this computer's agent in. A login it already has of that kind (a
 * terminal's, another app's) is picked up and nothing opens; otherwise the
 * CLI's own sign-in opens in the browser, and its end arrives as
 * The `agentAuthChanges` stream.
 */
export async function signInLocalAgent(harness: AgentHarness, auth: HarnessAuth): Promise<void> {
  const method = browserSignIn(auth);
  if (!method) return;
  // A browser opens a tab only while it handles the click: take it now, blank,
  // and send it to the sign-in page once the backend answers.
  const page = openExternalPending();
  try {
    const answer = await call(
      api.agentSignIn,
      { harness, method: method.id },
      { timeoutMs: 60_000 }
    );
    if ("already" in answer) {
      page.cancel();
      toast.success(`Already signed in on this computer: ${accountLine(answer.already)}`);
      return;
    }
    const url = answer.login.url ?? answer.login.codeUrl;
    if (url) await page.open(url);
    else page.cancel();
  } catch (error) {
    page.cancel();
    toast.error(reasonOf(error, "Couldn’t start the sign-in"));
  }
}

/** The code the sign-in page showed (signing in on another device). */
export async function finishLocalSignIn(loginId: string, code: string): Promise<void> {
  try {
    await call(api.agentLoginCode, { loginId, code });
  } catch (error) {
    toast.error(reasonOf(error, "That code didn’t work"));
  }
}

export async function cancelLocalSignIn(loginId: string): Promise<void> {
  await call(api.agentLoginCancel, { loginId }).catch(() => {});
}

export async function signOutLocalAgent(harness: AgentHarness): Promise<void> {
  try {
    await call(api.agentLogout, { harness });
  } catch (error) {
    toast.error(reasonOf(error, "Couldn’t sign out"));
  }
}
