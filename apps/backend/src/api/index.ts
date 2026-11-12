/** Every handler, collected. `registry` is what the query engine dispatches through. */

import automations from "./automations";
import browser from "./browser";
import devices from "./devices";
import files from "./files";
import integrations from "./integrations";
import repos from "./repos";
import sessions from "./sessions";
import settings from "./settings";
import simulator from "./simulator";
import terminal from "./terminal";
import workspaces from "./workspaces";
import { Registry } from "./registry";

export const registry = new Registry([
  ...automations,
  ...browser,
  ...devices,
  ...files,
  ...integrations,
  ...repos,
  ...sessions,
  ...settings,
  ...simulator,
  ...terminal,
  ...workspaces,
]);
