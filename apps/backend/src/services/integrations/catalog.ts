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
import { getInstallation } from "./store";

function catalogApps(): CatalogApp[] {
  return CATALOG.apps;
}

function catalogSkills(): CatalogSkill[] {
  return CATALOG.skills;
}

export function catalogPlugins(): CatalogPlugin[] {
  return CATALOG.plugins;
}

/**
 * The user's own app or skill: its definition lives on its installation row.
 * One row is read and parsed, not every custom item: this is asked once per
 * installed app at each turn's start.
 */
function customItem<T>(
  kind: "app" | "skill",
  id: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }
): T | null {
  const row = getInstallation(kind, id);
  if (row?.source !== "custom") return null;
  const parsed = schema.safeParse(row.definition);
  return parsed.success ? parsed.data : null;
}

export function findApp(id: string): CatalogApp | null {
  return catalogApps().find((app) => app.id === id) ?? customItem("app", id, CatalogAppSchema);
}

export function findSkill(id: string): CatalogSkill | null {
  return (
    catalogSkills().find((skill) => skill.id === id) ?? customItem("skill", id, CatalogSkillSchema)
  );
}

export function findPlugin(id: string): CatalogPlugin | null {
  return catalogPlugins().find((plugin) => plugin.id === id) ?? null;
}
