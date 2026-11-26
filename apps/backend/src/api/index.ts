/** Every handler, collected. `registry` is what the query engine dispatches through. */

import assistants from "./assistants";
import automations from "./automations";
import browser from "./browser";
import deviceHub from "./device-hub";
import devices from "./devices";
import files from "./files";
import integrations from "./integrations";
import repos from "./repos";
import sessions from "./sessions";
import settings from "./settings";
import cloudDevice from "./cloud-device";
import terminal from "./terminal";
import workspaces from "./workspaces";
import { Registry } from "./registry";

export const registry = new Registry([
  ...assistants,
  ...automations,
  ...browser,
  ...deviceHub,
  ...devices,
  ...files,
  ...integrations,
  ...repos,
  ...sessions,
  ...settings,
  ...cloudDevice,
  ...terminal,
  ...workspaces,
]);
