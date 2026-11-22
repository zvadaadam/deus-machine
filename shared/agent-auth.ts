// The local agents, between Deus's backend and its UI: each harness's CLI as
// the engine runs it (`clis/*`: installed ahead of a turn, with progress) and
// its login, read from the CLI, signed in through the CLI's own flow
// (`auth/*`). Deus shows them and starts installs and sign-ins.
import type {
  AuthLogin,
  AuthLoginEnd,
  HarnessAuth,
  HarnessCli,
} from "@zvada/agent-server/protocol";

export type {
  AuthLogin,
  AuthLoginEnd,
  AuthMethod,
  HarnessAuth,
  HarnessCli,
  HarnessCliProgress,
} from "@zvada/agent-server/protocol";

/** `agentAuth`: each harness's CLI and login, and the sign-ins under way. */
export interface AgentAuthAnswer {
  auth: HarnessAuth[];
  clis: HarnessCli[];
  /** As each start answered it: a window opened mid-sign-in still shows it. */
  logins: AuthLogin[];
  /** The engine could not be asked (not connected, or the read failed). */
  error?: string;
}

/**
 * `agentSignIn`: the login this computer already has of that kind
 * (nothing opens), or the sign-in under way.
 */
export type AgentSignInAnswer = { already: HarnessAuth } | { login: AuthLogin };

/**
 * The `agentAuthChanges` stream: a harness's login changed, a sign-in started
 * (`started`) or ended (`login`), whoever caused it; or a sign-in this
 * backend followed lost the engine (`disconnected`, no `auth`): read the
 * status again.
 */
export interface AgentAuthEvent {
  auth?: HarnessAuth;
  started?: AuthLogin;
  login?: AuthLoginEnd;
}
