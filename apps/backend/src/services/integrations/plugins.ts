// backend/src/services/integrations/plugins.ts
// Plugins: a bundle installs its apps and skills together. Which plugins
// include an item is read from the catalog, never stored: an item a plugin
// brought in (`explicit = 0`) goes when no installed plugin lists it any more,
// and an item the user added or connected themselves always stays.

import type { CatalogPlugin } from "@shared/integrations/types";
import { installApp, uninstallApp } from "./apps";
import { catalogPlugins, findApp, findPlugin, findSkill } from "./catalog";
import { integrationsChanged } from "./events";
import { installSkill, uninstallSkill } from "./skills";
import {
  deleteInstallation,
  getInstallation,
  listInstallations,
  upsertInstallation,
} from "./store";

function installedPlugins(): CatalogPlugin[] {
  const ids = new Set(listInstallations("plugin").map((row) => row.itemId));
  return catalogPlugins().filter((plugin) => ids.has(plugin.id));
}

export function installPlugin(pluginId: string): void {
  const plugin = findPlugin(pluginId);
  if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
  upsertInstallation({ kind: "plugin", itemId: plugin.id });
  for (const appId of plugin.apps) if (findApp(appId)) installApp(appId, { explicit: false });
  for (const skillId of plugin.skills) {
    if (findSkill(skillId)) installSkill(skillId, { explicit: false });
  }
  integrationsChanged();
}

/** Remove a plugin, and each of its parts nothing else needs. Accounts stay. */
export function uninstallPlugin(pluginId: string): void {
  const plugin = findPlugin(pluginId);
  deleteInstallation("plugin", pluginId);
  if (plugin) {
    const remaining = installedPlugins();
    for (const appId of plugin.apps) {
      const row = getInstallation("app", appId);
      if (row && !row.explicit && !remaining.some((p) => p.apps.includes(appId))) {
        uninstallApp(appId);
      }
    }
    for (const skillId of plugin.skills) {
      const row = getInstallation("skill", skillId);
      if (row && !row.explicit && !remaining.some((p) => p.skills.includes(skillId))) {
        uninstallSkill(skillId);
      }
    }
  }
  integrationsChanged();
}
