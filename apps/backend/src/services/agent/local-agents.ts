// backend/src/services/agent/local-agents.ts
// The local agents as the engine has them, over the standard wire: each
// harness's CLI (`clis/*`: the one turns run, installed ahead of a turn with
// its progress) and its login (`auth/*`: as the CLI says it, a sign-in
// through the CLI's own flow, the code a sign-in from another device shows,
// cancel and sign out). Clients follow `agentCliProgress` while a CLI installs,
// and `agentAuthChanges` for a login that changes and a sign-in that starts
// or ends, whoever caused it.

import { LoginError, type AgentServerClient, type LoginHandle } from "@zvada/agent-server/client";
import {
  signedInBy,
  type AuthLogin,
  type HarnessAuth,
  type ModelList,
} from "@zvada/agent-server/protocol";
import {
  LOCAL_HARNESSES,
  type AgentAuthAnswer,
  type AgentSignInAnswer,
  type LocalHarness,
} from "@shared/agent-auth";
import { agentAuthChanges, agentCliProgress } from "@shared/api/settings";
import { ValidationError } from "../../lib/errors";
import { publish } from "../streams";

/** What a sign-in's start answered, without the handle's functions. */
function answerOf(handle: LoginHandle): AuthLogin {
  const { done: _done, complete: _complete, cancel: _cancel, ...login } = handle;
  return login;
}

export class LocalAgents {
  /** Sign-ins this backend started and has not seen end: their code and cancel need the handle. */
  private readonly handles = new Map<string, LoginHandle>();
  private readonly offs: (() => void)[];

  constructor(private readonly client: AgentServerClient) {
    this.offs = [
      client.onAuthUpdated((update) => {
        // An ended sign-in leaves the list before the windows read it again.
        if (update.login) this.handles.delete(update.login.loginId);
        publish(agentAuthChanges, {}, update);
      }),
      client.onCliProgress((progress) => publish(agentCliProgress, {}, progress)),
    ];
  }

  /**
   * Each harness's CLI and login, and the sign-ins under way. No `env`, as
   * Deus's turns send none: the CLI and login they run on.
   */
  async status(): Promise<AgentAuthAnswer> {
    const harnesses = [...LOCAL_HARNESSES];
    const [clis, auth] = await Promise.all([
      this.client.listClis(harnesses),
      this.client.authStatus({ harnesses }),
    ]);
    return { auth, clis, logins: [...this.handles.values()].map(answerOf) };
  }

  /**
   * The models each harness offers a turn in `cwd`, as its CLI lists them for
   * this computer's login (the engine keeps a list ten minutes and reads again
   * when a login changes). A CLI that does not answer gets the engine's own
   * catalog, with the reason. No `env`, as for `status`.
   */
  models(cwd?: string): Promise<ModelList[]> {
    return Promise.all(
      LOCAL_HARNESSES.map((harness) => this.client.listModels({ harness, ...(cwd && { cwd }) }))
    );
  }

  /** Install the CLIs turns run, now: answered at once, the install told on `agentCliProgress`. */
  prepareClis(): void {
    this.client.prepareClis([...LOCAL_HARNESSES]).catch((error: unknown) => {
      console.warn("[LocalAgents] CLI install failed:", error);
    });
  }

  /**
   * Status first: a login this computer already has of that kind (a
   * terminal's, another app's) is picked up and nothing opens. Otherwise the
   * CLI's own sign-in starts.
   */
  async signIn(harness: LocalHarness, method: string, apiKey?: string): Promise<AgentSignInAnswer> {
    if (!apiKey) {
      const [auth] = await this.client.authStatus({ harnesses: [harness] });
      const chosen = auth?.methods.find((candidate) => candidate.id === method);
      if (auth && chosen && signedInBy(auth, chosen)) return { already: auth };
    }
    const handle = await this.client.login(harness, method, apiKey ? { apiKey } : {});
    const login = answerOf(handle);
    this.handles.set(login.loginId, handle);
    // Every window shows it under way (Cancel, the code's form), not "Sign in".
    publish(agentAuthChanges, {}, { started: login });
    void handle.done.then(
      () => this.handles.delete(login.loginId),
      (error: unknown) => {
        this.handles.delete(login.loginId);
        // Its end was told on a connection that dropped: say so, and the UI reads again.
        if (error instanceof LoginError && error.outcome === "disconnected") {
          publish(
            agentAuthChanges,
            {},
            {
              login: { loginId: login.loginId, outcome: "disconnected" },
            }
          );
        }
      }
    );
    return { login };
  }

  /** The code the sign-in page showed on another device (Claude). */
  async complete(loginId: string, code: string): Promise<HarnessAuth> {
    const handle = this.handles.get(loginId);
    if (!handle) throw new ValidationError("That sign-in is no longer under way: start it again.");
    return handle.complete(code.trim());
  }

  async cancel(loginId: string): Promise<void> {
    await this.handles.get(loginId)?.cancel();
  }

  /** The CLI's own sign-out: the terminal's login too, as it is the same one. */
  logout(harness: LocalHarness): Promise<HarnessAuth> {
    return this.client.logout(harness);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.handles.clear();
  }
}
