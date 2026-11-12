// backend/src/services/integrations — Apps, Plugins and Skills (Customize).
//
//   catalog.ts      the curated catalog + the user's own apps and skills
//   store.ts        extension_installations + integration_connections
//   vault.ts        sealed credentials
//   state.ts        what clients read: the catalog once, the state pushed
//   apps.ts         install · connect · remove an app
//   accounts.ts     an app's account rows: which one it uses, forgetting one
//   checks.ts       reach an app's server and list its tools (readiness)
//   cloud-apps.ts   apps connected through the person's Deus account
//   skills.ts       add · update · remove a skill
//   skill-files.ts  a skill's files where Claude and Codex load them
//   plugins.ts      a bundle installs its parts by reference
//   auth/           MCP OAuth; vendor-approved clients; accounts Deus Cloud holds
//   sign-in-route.ts  how an app's account is reached: here, or through Deus Cloud
//   credentials.ts  an account → the headers or env of one request
//   gateway.ts      the one door agents use to reach an app with an account
//   runtime.ts      a local turn's MCP servers
//   codex-homes.ts  the session-owned CODEX_HOME Codex needs for them
//   cloud-turns.ts  what a cloud turn carries: apps that reach the cloud, skills
//   probe.ts        an MCP client that connects and lists tools

import { getErrorMessage } from "@shared/lib/errors";
import { setSignInReturnBase } from "./auth/callback";
import { reconcileCloudAccounts } from "./cloud-apps";
import { pruneCodexSessionHomes } from "./codex-homes";
import { setGatewayPort } from "./gateway";
import { resumeSkillInstalls } from "./skills";
import { initVault } from "./vault";

export { completeOAuthCallback } from "./apps";
export { SIGN_IN_CALLBACK_PATH } from "./auth/callback";
export { completeCloudCallback, reconcileCloudAccounts } from "./cloud-apps";
export { resolveCloudTurnExtensions } from "./cloud-turns";
export { codexTurnHome } from "./codex-homes";
export { GATEWAY_PATH, isGatewayKey, proxyMcp } from "./gateway";
export { resolveTurnApps } from "./runtime";
export { getState } from "./state";

/** Once the backend listens: where sign-ins return and agents reach the gateway. */
export async function startIntegrations(port: number): Promise<void> {
  // Sign-ins return in the user's browser, which knows this computer as localhost.
  setSignInReturnBase(`http://localhost:${port}`);
  setGatewayPort(port);
  try {
    // The vault's key, found once here so no request waits on the Keychain.
    await initVault();
    resumeSkillInstalls();
    const pruned = pruneCodexSessionHomes();
    if (pruned) console.log(`[Integrations] Trimmed ${pruned} Codex session home(s)`);
  } catch (error) {
    console.warn("[Integrations] Startup failed:", getErrorMessage(error));
  }
  // The Deus account may already be signed in: line its connected apps up.
  void reconcileCloudAccounts();
}

// ---------------------------------------------------------------------------
// What the app's own UI reads and changes is answered in `api/integrations.ts`,
// which calls apps.ts, skills.ts, plugins.ts, checks.ts and state.ts directly.
//
// These two are what is left of the dispatch that used to live here. Nothing
// reaches them (the registry answers every name first); they exist because the
// old arms in query-engine.ts and query-request-dispatcher.ts still import
// them, and go when those arms do.
// ---------------------------------------------------------------------------

export function runIntegrationMutation(action: string, _params: unknown): never {
  throw new Error(`${action} is answered by api/integrations.ts`);
}

export function runIntegrationRequest(resource: string, _params: unknown): never {
  throw new Error(`${resource} is answered by api/integrations.ts`);
}
