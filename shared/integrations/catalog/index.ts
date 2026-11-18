/**
 * The curated catalog Deus ships: Apps (MCP integrations), Skills and
 * Recommended Plugins. Public data only — no secrets, no per-user state.
 *
 * Adding to it: an app needs a verified endpoint (probed, or documented by
 * its vendor) and its real auth; a skill needs a pinned commit with a
 * SKILL.md; a plugin references only ids defined here. After adding an app
 * with a new icon, run `bun scripts/generate-integration-icons.ts`.
 * test/unit/shared/integrations-catalog.test.ts checks every rule.
 */

import type { Catalog } from "../types";
import { CATALOG_APPS } from "./apps";
import { CATALOG_PLUGINS } from "./plugins";
import { CATALOG_SKILLS } from "./skills";

export const CATALOG: Catalog = {
  version: "2026-11-09",
  apps: CATALOG_APPS,
  skills: CATALOG_SKILLS,
  plugins: CATALOG_PLUGINS,
};
