/** Customize: the apps, plugins and skills installed on this computer. */

import { z } from "zod";
import {
  ConnectAppInputSchema,
  CustomAppInputSchema,
  CustomSkillInputSchema,
  InstallKindSchema,
  type AppTool,
  type Catalog,
  type ConnectAppResult,
  type IntegrationsState,
  type LocalSkill,
  type SkillContent,
} from "../integrations/types";
import { live, out, read, write } from "./op";

const appId = z.object({ appId: z.string().min(1) });
const skillId = z.object({ skillId: z.string().min(1) });
/** One entry of the catalog, or one the person added: an app, a skill or a plugin. */
const item = z.object({ id: z.string().min(1), kind: InstallKindSchema });

/** What is installed and connected. `composeSnapshot` joins it with the catalog. */
export const integrations = live({ name: "integrations", output: out<IntegrationsState>() });

/** The curated apps, skills and plugins. The same for a whole build: read once per `catalogVersion`. */
export const integrationsCatalog = read({ name: "integrationsCatalog", output: out<Catalog>() });

/** The tools an app's server listed when it was last checked. */
export const appTools = read({ name: "appTools", input: appId, output: out<AppTool[]>() });

/** A skill's SKILL.md and files: the installed copy, else GitHub at the pinned commit. */
export const skillContent = read({
  name: "skillContent",
  input: skillId,
  output: out<SkillContent>(),
});

/** Skills already on this computer that Deus did not install. */
export const localSkills = read({ name: "localSkills", output: out<LocalSkill[]>() });

/** Install an app, add a skill, or install a plugin with the apps and skills it bundles. */
export const installIntegration = write({
  name: "installIntegration",
  input: item,
  output: out<void>(),
});

/** Remove it. An app's account goes with it; a plugin takes the parts nothing else needs. */
export const uninstallIntegration = write({
  name: "uninstallIntegration",
  input: item,
  output: out<void>(),
});

/** Switch an installed app or skill off or on without removing it. A plugin has no switch. */
export const setIntegrationEnabled = write({
  name: "setIntegrationEnabled",
  input: item.extend({ enabled: z.boolean() }),
  output: out<void>(),
});

/** Give an app its account. A sign-in answers with a page to open; a key or token connects at once. */
export const connectApp = write({
  name: "connectApp",
  input: ConnectAppInputSchema,
  output: out<ConnectAppResult>(),
});

/** Forget an app's account. The app stays installed. */
export const disconnectApp = write({ name: "disconnectApp", input: appId, output: out<void>() });

/**
 * Reach an app's server with its account and list its tools. Answers when the
 * check is done, which for a local server's first run can take over a minute.
 */
export const checkApp = write({ name: "checkApp", input: appId, output: out<void>() });

/** Add the person's own MCP server as an app. */
export const addCustomApp = write({
  name: "addCustomApp",
  input: CustomAppInputSchema,
  output: out<{ appId: string }>(),
});

/** Add a skill from a GitHub link. Answers once it is downloaded, which can take two minutes. */
export const addCustomSkill = write({
  name: "addCustomSkill",
  input: CustomSkillInputSchema,
  output: out<{ skillId: string }>(),
});

/** Download a skill again: after a failed install, or to move to the catalog's newer version. */
export const updateSkill = write({ name: "updateSkill", input: skillId, output: out<void>() });
