import { toast } from "sonner";
import type { AgentAuthAnswer, AuthLogin, HarnessAuth, LocalHarness } from "@shared/agent-auth";
import { openExternal } from "@/platform/native/window";
import { sendCommand } from "@/platform/ws";

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

/** Install the agents' CLIs now; the install is followed on q:event "agent:cli". */
export async function installLocalAgents(): Promise<void> {
  const ack = await sendCommand("agentPrepareClis", {});
  if (!ack.accepted) toast.error(ack.error || "Couldn’t start the install");
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
  try {
    const ack = await sendCommand("agentSignIn", { harness, method: method.id }, 60_000);
    if (!ack.accepted) throw new Error(ack.error || "Couldn’t start the sign-in");
    const answer = ack as unknown as Partial<{ already: HarnessAuth; login: AuthLogin }>;
    if (answer.already) {
      toast.success(`Already signed in on this computer: ${accountLine(answer.already)}`);
      return;
    }
    if (!answer.login) throw new Error("The sign-in didn’t start");
    const url = answer.login.url ?? answer.login.codeUrl;
    if (url) await openExternal(url);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Couldn’t start the sign-in");
  }
}

/** The code the sign-in page showed (signing in on another device). */
export async function finishLocalSignIn(loginId: string, code: string): Promise<void> {
  const ack = await sendCommand("agentLoginCode", { loginId, code });
  if (!ack.accepted) toast.error(ack.error || "That code didn’t work");
}

export async function cancelLocalSignIn(loginId: string): Promise<void> {
  await sendCommand("agentLoginCancel", { loginId }).catch(() => {});
}

export async function signOutLocalAgent(harness: LocalHarness): Promise<void> {
  const ack = await sendCommand("agentLogout", { harness });
  if (!ack.accepted) toast.error(ack.error || "Couldn’t sign out");
}
