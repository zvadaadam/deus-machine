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

import { match } from "ts-pattern";
import type { QueryParams } from "../../lib/query-params";
import { requireParam } from "../../lib/query-params";
import { getErrorMessage } from "@shared/lib/errors";
import {
  ConnectAppInputSchema,
  CustomAppInputSchema,
  CustomSkillInputSchema,
  type InstallKind,
} from "@shared/integrations/types";
import {
  addCustomApp,
  connectApp,
  disconnectApp,
  installApp,
  setAppEnabled,
  uninstallApp,
} from "./apps";
import { setSignInReturnBase } from "./auth/callback";
import { checkApp } from "./checks";
import { reconcileCloudAccounts } from "./cloud-apps";
import { pruneCodexSessionHomes } from "./codex-homes";
import { setGatewayPort } from "./gateway";
import { installPlugin, uninstallPlugin } from "./plugins";
import {
  addCustomSkill,
  getLocalSkills,
  getSkillContent,
  installSkill,
  reinstallSkill,
  resumeSkillInstalls,
  setSkillEnabled,
  uninstallSkill,
} from "./skills";
import { getCatalog } from "./state";
import { readAppTools } from "./store";
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
// q:mutate and q:request entry points (query-engine routes them here)
// ---------------------------------------------------------------------------

export type IntegrationMutation =
  | "installIntegration"
  | "uninstallIntegration"
  | "setIntegrationEnabled"
  | "connectApp"
  | "disconnectApp"
  | "checkApp"
  | "addCustomApp"
  | "addCustomSkill"
  | "updateSkill";

function readKind(params: QueryParams, action: string): InstallKind {
  const kind = requireParam(params, "kind", action);
  if (kind !== "app" && kind !== "skill" && kind !== "plugin") {
    throw new Error(`${action} kind must be app, skill or plugin`);
  }
  return kind;
}

export async function runIntegrationMutation(
  action: IntegrationMutation,
  params: QueryParams
): Promise<unknown> {
  return match(action)
    .with("installIntegration", () => {
      const id = requireParam(params, "id", action);
      match(readKind(params, action))
        .with("app", () => installApp(id))
        .with("skill", () => installSkill(id))
        .with("plugin", () => installPlugin(id))
        .exhaustive();
      return { success: true };
    })
    .with("uninstallIntegration", () => {
      const id = requireParam(params, "id", action);
      match(readKind(params, action))
        .with("app", () => uninstallApp(id))
        .with("skill", () => uninstallSkill(id))
        .with("plugin", () => uninstallPlugin(id))
        .exhaustive();
      return { success: true };
    })
    .with("setIntegrationEnabled", () => {
      const id = requireParam(params, "id", action);
      const enabled = params.enabled === true;
      match(readKind(params, action))
        .with("app", () => setAppEnabled(id, enabled))
        .with("skill", () => setSkillEnabled(id, enabled))
        .with("plugin", () => {
          throw new Error("A plugin is installed or not; switch its apps and skills instead");
        })
        .exhaustive();
      return { success: true };
    })
    .with("connectApp", () => connectApp(ConnectAppInputSchema.parse(params)))
    .with("disconnectApp", () => {
      disconnectApp(requireParam(params, "appId", action));
      return { success: true };
    })
    .with("checkApp", async () => {
      await checkApp(requireParam(params, "appId", action));
      return { success: true };
    })
    .with("addCustomApp", () => addCustomApp(CustomAppInputSchema.parse(params)))
    .with("addCustomSkill", () => addCustomSkill(CustomSkillInputSchema.parse(params).source))
    .with("updateSkill", () => {
      reinstallSkill(requireParam(params, "skillId", action));
      return { success: true };
    })
    .exhaustive();
}

export type IntegrationRequest =
  | "integrationsCatalog"
  | "appTools"
  | "skillContent"
  | "localSkills";

export function runIntegrationRequest(
  resource: IntegrationRequest,
  params: QueryParams
): unknown | Promise<unknown> {
  return match(resource)
    .with("integrationsCatalog", () => getCatalog())
    .with("appTools", () => readAppTools(requireParam(params, "appId", resource)))
    .with("skillContent", () => getSkillContent(requireParam(params, "skillId", resource)))
    .with("localSkills", () => getLocalSkills())
    .exhaustive();
}
