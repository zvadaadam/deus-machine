// backend/src/services/integrations/skills.ts
// Skills: add, switch on and off, update, remove. Files are fetched in the
// background (the row says `installing` until they land) and live where the
// agents load them (skill-files.ts); the row records the commit on disk.

import { getErrorMessage } from "@shared/lib/errors";
import type { CatalogSkill, LocalSkill, SkillContent } from "@shared/integrations/types";
import { findSkill } from "./catalog";
import { integrationsChanged } from "./events";
import {
  discardFetched,
  fetchSkill,
  listLocalSkills,
  parseSkillSource,
  placeSkill,
  readSkillContent,
  removeSkill,
  setSkillPlaced,
  skillFilesKept,
} from "./skill-files";
import {
  deleteInstallation,
  getInstallation,
  listInstallations,
  upsertInstallation,
} from "./store";

const jobs = new Map<string, Promise<void>>();

function requireSkill(skillId: string): CatalogSkill {
  const skill = findSkill(skillId);
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);
  return skill;
}

/**
 * Add a skill. `explicit: false` is a plugin bringing it in: a skill the user
 * already added themselves stays theirs.
 */
export function installSkill(skillId: string, options: { explicit?: boolean } = {}): void {
  const skill = requireSkill(skillId);
  const current = getInstallation("skill", skill.id);
  const explicit = options.explicit ?? true;
  if (current) {
    if (explicit && !current.explicit) {
      upsertInstallation({ kind: "skill", itemId: skill.id, explicit });
    }
    if (current.status === "error") fetchInBackground(skill);
  } else {
    upsertInstallation({ kind: "skill", itemId: skill.id, explicit, status: "installing" });
    fetchInBackground(skill);
  }
  integrationsChanged();
}

/** Download the skill at its pinned commit and place it; one download per skill at a time. */
function fetchInBackground(skill: CatalogSkill): void {
  if (jobs.has(skill.id)) return;
  // What is on disk before this download: a failed update leaves it working.
  // The files say so, not the status: an update Deus quit in the middle of
  // is `installing` when it is resumed, over files that still work (or, quit
  // between the swap's two renames, over none).
  const before = getInstallation("skill", skill.id);
  const working = Boolean(before?.installedRef) && skillFilesKept(skill.name, skill.id);
  upsertInstallation({ kind: "skill", itemId: skill.id, status: "installing", error: null });
  const job = (async () => {
    let fetched;
    try {
      fetched = await fetchSkill(skill.source);
      // Removed while it downloaded: nothing to place.
      const row = getInstallation("skill", skill.id);
      if (!row) return;
      placeSkill({
        id: skill.id,
        name: skill.name,
        stagedDir: fetched.dir,
        source: skill.source,
        sha: fetched.sha,
      });
      if (!row.enabled) setSkillPlaced(skill.name, skill.id, false);
      upsertInstallation({
        kind: "skill",
        itemId: skill.id,
        status: "ready",
        error: null,
        installedRef: fetched.sha,
      });
    } catch (error) {
      if (getInstallation("skill", skill.id)) {
        upsertInstallation({
          kind: "skill",
          itemId: skill.id,
          // The files of the version that worked are still in place.
          status: working ? "ready" : "error",
          error: working ? `Update failed: ${getErrorMessage(error)}` : getErrorMessage(error),
        });
      }
    } finally {
      if (fetched) discardFetched(fetched);
      jobs.delete(skill.id);
      integrationsChanged();
    }
  })();
  jobs.set(skill.id, job);
}

/** Wait for the downloads under way (tests; shutdown). */
export async function settleSkillJobs(): Promise<void> {
  await Promise.allSettled([...jobs.values()]);
}

export function uninstallSkill(skillId: string): void {
  // Delete the row first: a download still under way sees it gone and places nothing.
  deleteInstallation("skill", skillId);
  try {
    removeSkill(skillId);
  } catch (error) {
    console.warn("[Integrations] Removing skill files failed:", getErrorMessage(error));
  }
  integrationsChanged();
}

export function setSkillEnabled(skillId: string, enabled: boolean): void {
  const skill = findSkill(skillId);
  const row = getInstallation("skill", skillId);
  if (!skill || !row) throw new Error("Add the skill first");
  // Whenever its files are on disk, whatever the last download did.
  if (row.installedRef) setSkillPlaced(skill.name, skill.id, enabled);
  upsertInstallation({ kind: "skill", itemId: skillId, enabled });
  integrationsChanged();
}

/** Download a skill again: after a failed install, or to move to the catalog's newer pin. */
export function reinstallSkill(skillId: string): void {
  const skill = findSkill(skillId);
  if (!skill || !getInstallation("skill", skillId)) throw new Error("Add the skill first");
  fetchInBackground(skill);
  integrationsChanged();
}

/** Add a skill from a GitHub link. Fetched first, to learn its name and pin its commit. */
export async function addCustomSkill(source: string): Promise<{ skillId: string }> {
  const parsed = parseSkillSource(source);
  const fetched = await fetchSkill(parsed);
  try {
    const id = `custom/${parsed.repo.toLowerCase()}/${fetched.name}`.replace(/[^a-z0-9._/-]/g, "-");
    if (findSkill(id) && getInstallation("skill", id)) {
      throw new Error(`"${fetched.name}" from ${parsed.repo} is already added`);
    }
    const pinned = { ...parsed, ref: fetched.sha };
    const skill: CatalogSkill = {
      id,
      name: fetched.name,
      title: fetched.name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      description: fetched.description.slice(0, 300),
      categories: ["developer"],
      publisher: parsed.repo.split("/")[0]!,
      official: false,
      source: pinned,
      requiresApps: [],
      homepage: `https://github.com/${parsed.repo}/tree/${fetched.sha}/${parsed.path}`.replace(
        /\/$/,
        ""
      ),
    };
    // Place before recording: a name the user already holds refuses here, with no row left behind.
    placeSkill({ id, name: skill.name, stagedDir: fetched.dir, source: pinned, sha: fetched.sha });
    upsertInstallation({
      kind: "skill",
      itemId: id,
      definition: skill,
      explicit: true,
      status: "ready",
      installedRef: fetched.sha,
    });
    integrationsChanged();
    return { skillId: id };
  } finally {
    discardFetched(fetched);
  }
}

/** A skill's SKILL.md and files, for its page. */
export function getSkillContent(skillId: string): Promise<SkillContent> {
  const skill = requireSkill(skillId);
  return readSkillContent(skill.name, skill.id, skill.source);
}

/** Skills already on this computer that are not in Deus's list. */
export function getLocalSkills(): LocalSkill[] {
  const installed = new Set(listInstallations("skill").map((row) => row.itemId));
  return listLocalSkills((id) => installed.has(id));
}

/** Pick up downloads a restart interrupted. */
export function resumeSkillInstalls(): void {
  for (const row of listInstallations("skill")) {
    if (row.status !== "installing") continue;
    const skill = findSkill(row.itemId);
    if (skill) fetchInBackground(skill);
  }
}
