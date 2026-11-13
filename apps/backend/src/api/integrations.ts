/** Answers the operations in `shared/api/integrations.ts`. */

import { match } from "ts-pattern";
import * as api from "@shared/api/integrations";
import {
  addCustomApp,
  connectApp,
  disconnectApp,
  installApp,
  setAppEnabled,
  uninstallApp,
} from "../services/integrations/apps";
import { checkApp } from "../services/integrations/checks";
import { installPlugin, uninstallPlugin } from "../services/integrations/plugins";
import {
  addCustomSkill,
  getLocalSkills,
  getSkillContent,
  installSkill,
  reinstallSkill,
  setSkillEnabled,
  uninstallSkill,
} from "../services/integrations/skills";
import { getCatalog, getState } from "../services/integrations/state";
import { readAppTools } from "../services/integrations/store";
import { handle } from "./registry";
import { ValidationError } from "../lib/errors";

// Every write tells `integrations` subscribers itself (`integrationsChanged`).
export default [
  handle(api.integrations, () => getState()),
  handle(api.integrationsCatalog, () => getCatalog()),
  handle(api.appTools, ({ appId }) => readAppTools(appId)),
  handle(api.skillContent, ({ skillId }) => getSkillContent(skillId)),
  handle(api.localSkills, () => getLocalSkills()),

  handle(api.installIntegration, ({ kind, id }) =>
    match(kind)
      .with("app", () => installApp(id))
      .with("skill", () => installSkill(id))
      .with("plugin", () => installPlugin(id))
      .exhaustive()
  ),
  handle(api.uninstallIntegration, ({ kind, id }) =>
    match(kind)
      .with("app", () => uninstallApp(id))
      .with("skill", () => uninstallSkill(id))
      .with("plugin", () => uninstallPlugin(id))
      .exhaustive()
  ),
  handle(api.setIntegrationEnabled, ({ kind, id, enabled }) =>
    match(kind)
      .with("app", () => setAppEnabled(id, enabled))
      .with("skill", () => setSkillEnabled(id, enabled))
      .with("plugin", () => {
        throw new ValidationError(
          "A plugin is installed or not; switch its apps and skills instead"
        );
      })
      .exhaustive()
  ),

  handle(api.connectApp, (input) => connectApp(input)),
  handle(api.disconnectApp, ({ appId }) => disconnectApp(appId)),
  handle(api.checkApp, ({ appId }) => checkApp(appId)),
  handle(api.addCustomApp, (input) => addCustomApp(input)),
  handle(api.addCustomSkill, ({ source }) => addCustomSkill(source)),
  handle(api.updateSkill, ({ skillId }) => reinstallSkill(skillId)),
];
