// backend/src/services/integrations/catalog.ts
// Finding an item by id: the curated catalog (shared/integrations/catalog)
// first, then the user's own apps and skills, whose definitions live on their
// installation rows. Catalog data ships with the app; a hosted catalog (Deus
// Cloud) can replace the bundled one without changing anything that reads
// through here.

import { CATALOG } from "@shared/integrations/catalog";
import {
  CatalogAppSchema,
  CatalogSkillSchema,
  type CatalogApp,
  type CatalogPlugin,
  type CatalogSkill,
} from "@shared/integrations/types";
import { listInstallations } from "./store";

function catalogApps(): CatalogApp[] {
  return CATALOG.apps;
}

function catalogSkills(): CatalogSkill[] {
  return CATALOG.skills;
}

export function catalogPlugins(): CatalogPlugin[] {
  return CATALOG.plugins;
}

/** Custom apps the user added, from their installation rows. */
function customApps(): CatalogApp[] {
  return listInstallations("app").flatMap((row) => {
    if (row.source !== "custom") return [];
    const parsed = CatalogAppSchema.safeParse(row.definition);
    return parsed.success ? [parsed.data] : [];
  });
}

function customSkills(): CatalogSkill[] {
  return listInstallations("skill").flatMap((row) => {
    if (row.source !== "custom") return [];
    const parsed = CatalogSkillSchema.safeParse(row.definition);
    return parsed.success ? [parsed.data] : [];
  });
}

export function findApp(id: string): CatalogApp | null {
  return (
    catalogApps().find((app) => app.id === id) ?? customApps().find((app) => app.id === id) ?? null
  );
}

export function findSkill(id: string): CatalogSkill | null {
  return (
    catalogSkills().find((skill) => skill.id === id) ??
    customSkills().find((skill) => skill.id === id) ??
    null
  );
}

export function findPlugin(id: string): CatalogPlugin | null {
  return catalogPlugins().find((plugin) => plugin.id === id) ?? null;
}
