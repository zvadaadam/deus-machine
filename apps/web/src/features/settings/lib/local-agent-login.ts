import { toast } from "sonner";
import type { AgentAuthAnswer, AuthLogin, HarnessAuth, LocalHarness } from "@shared/agent-auth";
import { api } from "@shared/api";
import { openExternalPending } from "@/platform/native/window";
import { call } from "@/platform/ws";

/** A local agent as the engine has it: its CLI, then its login, read from the CLI. */
export type LocalAgentState =
  | { status: "checking" | "failed" }
  | { status: "installing"; version?: string; percent?: number }
  | { status: "not-installed"; error?: string }
  | { status: "signed-out"; auth: HarnessAuth; login?: AuthLogin }
  | { status: "signed-in"; auth: HarnessAuth; account: string };

/** "Claude Max · you@example.com". */
export function accountLine(auth: HarnessAuth): string {
  return [auth.label, auth.email, auth.organization].filter(Boolean).join(" · ") || "Signed in";
}

/** An unknown login, or one the read could not get, is not a signed-out one. */
export function readLocalAgent(
  query: { data?: AgentAuthAnswer; isLoading: boolean; isError: boolean },
  harness: LocalHarness
): LocalAgentState {
  if (query.isLoading) return { status: "checking" };
  if (query.isError || query.data?.error) return { status: "failed" };
  // The CLI first: a login read from a CLI not installed yet says nothing.
  const cli = query.data?.clis.find((candidate) => candidate.harness === harness);
  if (cli?.state === "installing") {
    return {
      status: "installing",
      ...(cli.version && { version: cli.version }),
      ...(cli.totalBytes &&
        cli.receivedBytes !== undefined && {
          percent: Math.floor((cli.receivedBytes / cli.totalBytes) * 100),
        }),
    };
  }
  if (cli?.state === "missing" || cli?.state === "failed") {
    return { status: "not-installed", ...(cli.error && { error: cli.error }) };
  }
  const auth = query.data?.auth.find((candidate) => candidate.harness === harness);
  if (!auth || auth.state === "unknown") {
    return { status: "failed" };
  }
  if (auth.state === "signed_in") return { status: "signed-in", auth, account: accountLine(auth) };
  const login = query.data?.logins.find((candidate) => candidate.harness === harness);
  return { status: "signed-out", auth, ...(login && { login }) };
}

/** Why a request was refused or failed, for a toast. */
function reasonOf(error: unknown, otherwise: string): string {
  return (error instanceof Error && error.message) || otherwise;
}

/** Install the agents' CLIs now; the install is followed on q:event "agent:cli". */
export async function installLocalAgents(): Promise<void> {
  try {
    await call(api.agentPrepareClis);
  } catch (error) {
    toast.error(reasonOf(error, "Couldn’t start the install"));
  }
}

/** The sign-in Deus offers: the subscription's own, in the browser. */
function browserSignIn(auth: HarnessAuth) {
  return auth.methods.find(
    (method) => method.kind === "browser" && method.credential === "subscription"
  );
}

export function canSignIn(auth: HarnessAuth): boolean {
  return browserSignIn(auth) !== undefined;
}

/**
 * Sign this computer's agent in. A login it already has of that kind (a
 * terminal's, another app's) is picked up and nothing opens; otherwise the
 * CLI's own sign-in opens in the browser, and its end arrives as
 * q:event "agent:auth".
 */
export async function signInLocalAgent(harness: LocalHarness, auth: HarnessAuth): Promise<void> {
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

export async function signOutLocalAgent(harness: LocalHarness): Promise<void> {
  try {
    await call(api.agentLogout, { harness });
  } catch (error) {
    toast.error(reasonOf(error, "Couldn’t sign out"));
  }
}
