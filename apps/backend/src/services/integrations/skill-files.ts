// backend/src/services/integrations/skill-files.ts
// Skills on disk. Puts a skill where every local agent loads it, in the layout the Skills
// CLI (`npx skills add -g`) uses, so the two interoperate:
//
//   ~/.agents/skills/<name>/   the files (Codex loads this folder)
//   ~/.claude/skills/<name>    → symlink to it (Claude Code loads this one)
//
// A `.deus-skill.json` marker inside the folder records that Deus installed
// it and from where; nothing without our marker is ever replaced or removed.
// A disabled skill moves to Deus's own data folder, out of the agents' sight,
// and moves back when enabled.
//
// Files come from GitHub: the repo's tarball at a pinned commit, the skill's
// folder extracted. Symlinks inside a skill are skipped (a skill is files),
// and the folder must resolve inside the repository it came from.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { DB_PATH } from "../../lib/database";
import type { LocalSkill, SkillContent, SkillSource } from "@shared/integrations/types";

const execFileAsync = promisify(execFile);

const MARKER = ".deus-skill.json";
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

/**
 * What the marker records. A cloud sandbox writes the same file (AGNT's
 * sidecar, apps/sidecar/src/agents/skills.ts) with `name`/`repo`/`path`; the
 * desktop adds its catalog `id` and `source`, so either reads the other's.
 */
interface SkillMarker {
  installedBy: "deus";
  id: string;
  name: string;
  repo: string;
  path: string;
  source: SkillSource;
  ref: string;
  installedAt: string;
}

/** The home the agents read skills from. Tests point it at a scratch folder. */
function home(): string {
  return process.env.DEUS_SKILLS_HOME || os.homedir();
}

export function agentsSkillsDir(): string {
  return path.join(home(), ".agents", "skills");
}

export function claudeSkillsDir(): string {
  return path.join(home(), ".claude", "skills");
}

function disabledDir(): string {
  return path.join(path.dirname(DB_PATH), "skills-disabled");
}

function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
}

function readMarker(dir: string): SkillMarker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
    return marker?.installedBy === "deus" ? (marker as SkillMarker) : null;
  } catch {
    return null;
  }
}

function isOurs(dir: string, id: string): boolean {
  return readMarker(dir)?.id === id;
}

/** Parse a SKILL.md's frontmatter (name, description, …). */
export function parseSkillFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1]!);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Fetch from GitHub
// ---------------------------------------------------------------------------

/** A commit sha for `ref` (a 40-char sha passes through). */
async function resolveRef(repo: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    {
      headers: { Accept: "application/vnd.github.sha", "User-Agent": "Deus" },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `GitHub has no ${repo} at "${ref}"`
        : `GitHub answered ${response.status} resolving ${repo}@${ref}`
    );
  }
  const sha = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Unexpected commit from GitHub: ${sha}`);
  return sha.toLowerCase();
}

async function downloadTarball(repo: string, sha: string, into: string): Promise<string> {
  const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, {
    headers: { "User-Agent": "Deus" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} downloading ${repo}`);
  const tooLarge = () => new Error(`${repo} is too large to install a skill from`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_TARBALL_BYTES) throw tooLarge();
  if (!response.body) throw new Error(`GitHub sent nothing for ${repo}`);
  // Straight to disk, counted as it comes: the backend's memory is the agents' too.
  const file = path.join(into, "repo.tar.gz");
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.byteLength;
        if (received > MAX_TARBALL_BYTES) throw tooLarge();
        yield chunk;
      }
    },
    fs.createWriteStream(file)
  );
  return file;
}

/** Whether `inner` is `outer` or inside it, with symlinks resolved on both. */
function contains(outer: string, inner: string): boolean {
  const relative = path.relative(fs.realpathSync(outer), fs.realpathSync(inner));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Copy a folder's regular files and folders; symlinks and specials stay behind. */
function copyFiles(from: string, to: string): number {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === MARKER) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyFiles(source, target);
    else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

export interface FetchedSkill {
  /** A staging folder holding the skill's files, for `placeSkill` to move. */
  dir: string;
  /** The temp folder the fetch made; `discardFetched` removes it. */
  workDir: string;
  sha: string;
  name: string;
  description: string;
  files: number;
}

/**
 * Download `source` into a staging folder and read its SKILL.md. The folder
 * name the agents load is the frontmatter `name` (falling back to the
 * folder's own name), checked to be a safe slug.
 */
export async function fetchSkill(source: SkillSource): Promise<FetchedSkill> {
  const sha = await resolveRef(source.repo, source.ref);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "deus-skill-"));
  try {
    const tarball = await downloadTarball(source.repo, sha, work);
    const extracted = path.join(work, "x");
    fs.mkdirSync(extracted);
    await execFileAsync("tar", ["-xzf", tarball, "-C", extracted], { timeout: 120_000 });
    const [top] = fs.readdirSync(extracted);
    if (!top) throw new Error(`${source.repo} is empty`);
    const root = path.join(extracted, top);
    const skillRoot = path.resolve(root, source.path || ".");
    const skillMd = path.join(skillRoot, "SKILL.md");
    if (!fs.existsSync(skillMd) || !fs.lstatSync(skillMd).isFile()) {
      throw new Error(`No SKILL.md at ${source.repo}/${source.path || "(root)"}`);
    }
    // A path with `..`, or a folder that is a link out of the repository, is refused.
    if (!contains(root, skillRoot)) throw new Error("Skill path leaves the repository");
    const frontmatter = parseSkillFrontmatter(fs.readFileSync(skillMd, "utf8"));
    const name = String(frontmatter.name ?? path.basename(skillRoot))
      .trim()
      .toLowerCase();
    assertSkillName(name);
    const staged = path.join(work, "skill");
    const files = copyFiles(skillRoot, staged);
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
    return {
      dir: staged,
      workDir: work,
      sha,
      name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      files,
    };
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Parse what a user pastes as a skill source:
 *  - `https://github.com/owner/repo/tree/<ref>/<path>` (or `/blob/<ref>/<path>/SKILL.md`)
 *  - `https://github.com/owner/repo`
 *  - `owner/repo` or `owner/repo/path/to/skill` (default branch)
 */
export function parseSkillSource(input: string): SkillSource {
  const trimmed = input.trim().replace(/\/+$/, "");
  const url = trimmed.match(
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/
  );
  if (url) {
    const [, owner, repo, ref, rest] = url;
    return {
      repo: `${owner}/${repo}`,
      ref: ref ?? "HEAD",
      path: (rest ?? "").replace(/\/?SKILL\.md$/, ""),
    };
  }
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
  if (short) {
    const [, owner, repo, rest] = short;
    return { repo: `${owner}/${repo}`, ref: "HEAD", path: rest ?? "" };
  }
  throw new Error("Paste a GitHub link to a skill folder, or owner/repo/path");
}

// ---------------------------------------------------------------------------
// Place / remove
// ---------------------------------------------------------------------------

function sameTarget(link: string, target: string): boolean {
  try {
    return (
      fs.lstatSync(link).isSymbolicLink() &&
      path.resolve(path.dirname(link), fs.readlinkSync(link)) === target
    );
  } catch {
    return false;
  }
}

/**
 * Put the folder `from` at `to`, replacing what is there. The new folder is
 * brought beside the target first (under a hidden name, so a half-copied
 * folder is not listed as a skill) and swapped in by two renames: an agent
 * reading the skill meanwhile never finds it half written. Between the two
 * renames the path is empty, for about a tenth of a millisecond. A swap that
 * fails puts the old folder back.
 */
function moveDir(from: string, to: string): void {
  const parent = path.dirname(to);
  fs.mkdirSync(parent, { recursive: true });
  const incoming = path.join(parent, `.${path.basename(to)}.incoming-${process.pid}`);
  const outgoing = path.join(parent, `.${path.basename(to)}.outgoing-${process.pid}`);
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.rmSync(outgoing, { recursive: true, force: true });
  try {
    fs.renameSync(from, incoming);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another volume (the temp folder, Deus's data folder): copy next to the target.
    fs.cpSync(from, incoming, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  const replaced = fs.existsSync(to);
  if (replaced) fs.renameSync(to, outgoing);
  try {
    fs.renameSync(incoming, to);
  } catch (error) {
    if (replaced) fs.renameSync(outgoing, to);
    fs.rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(outgoing, { recursive: true, force: true });
}

/** Why `name` cannot be placed for `id`, or null when it can. */
export function placementConflict(name: string, id: string): string | null {
  const canonical = path.join(agentsSkillsDir(), name);
  if (fs.existsSync(canonical) && !isOurs(canonical, id)) {
    return `A skill named "${name}" is already in ~/.agents/skills`;
  }
  // Another skill of that name, switched off: its files wait in Deus's folder.
  const parked = path.join(disabledDir(), name);
  if (fs.existsSync(parked) && !isOurs(parked, id)) {
    return `Another skill named "${name}" is added and switched off; remove it first`;
  }
  const link = path.join(claudeSkillsDir(), name);
  let linkExists = false;
  try {
    fs.lstatSync(link);
    linkExists = true;
  } catch {
    // free
  }
  if (linkExists && !sameTarget(link, canonical)) {
    return `A skill named "${name}" is already in ~/.claude/skills`;
  }
  return null;
}

/** Install staged files as skill `name` for catalog/custom id `id`. */
export function placeSkill(input: {
  id: string;
  name: string;
  stagedDir: string;
  source: SkillSource;
  sha: string;
}): void {
  assertSkillName(input.name);
  const conflict = placementConflict(input.name, input.id);
  if (conflict) throw new Error(conflict);
  const marker: SkillMarker = {
    installedBy: "deus",
    id: input.id,
    name: input.name,
    repo: input.source.repo,
    path: input.source.path,
    source: input.source,
    ref: input.sha,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(input.stagedDir, MARKER), JSON.stringify(marker, null, 2));
  const canonical = path.join(agentsSkillsDir(), input.name);
  moveDir(input.stagedDir, canonical);
  // Its own parked copy (it was switched off) is now stale; `placementConflict`
  // has refused a parked copy that is another skill's.
  fs.rmSync(path.join(disabledDir(), input.name), { recursive: true, force: true });
  linkForClaude(input.name);
}

function linkForClaude(name: string): void {
  const canonical = path.join(agentsSkillsDir(), name);
  const link = path.join(claudeSkillsDir(), name);
  fs.mkdirSync(claudeSkillsDir(), { recursive: true });
  if (sameTarget(link, canonical)) return;
  // `placementConflict` has already refused a name the user holds there.
  fs.symlinkSync(canonical, link, "dir");
}

/** Remove Claude's link to our folder. Anything else at that name is the user's. */
function unlinkForClaude(name: string): void {
  const canonical = path.join(agentsSkillsDir(), name);
  const link = path.join(claudeSkillsDir(), name);
  if (sameTarget(link, canonical)) fs.unlinkSync(link);
}

/**
 * Remove the files Deus placed for skill `id`, wherever they are (in the
 * agents' folder, or parked while switched off). Found by marker, so a skill
 * the catalog no longer lists is still removable. Others' skills are left alone.
 */
export function removeSkill(id: string): void {
  for (const [dir, placed] of [
    [agentsSkillsDir(), true],
    [disabledDir(), false],
  ] as const) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const folder = path.join(dir, name);
      if (!isOurs(folder, id)) continue;
      if (placed) unlinkForClaude(name);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

/** Hide a skill from the agents without deleting it, or bring it back. */
export function setSkillPlaced(name: string, id: string, placed: boolean): void {
  assertSkillName(name);
  const canonical = path.join(agentsSkillsDir(), name);
  const parked = path.join(disabledDir(), name);
  if (placed) {
    if (!isOurs(canonical, id)) {
      if (!isOurs(parked, id)) throw new Error(`The files for "${name}" are missing; reinstall it`);
      const conflict = placementConflict(name, id);
      if (conflict) throw new Error(conflict);
      moveDir(parked, canonical);
    }
    linkForClaude(name);
  } else if (isOurs(canonical, id)) {
    unlinkForClaude(name);
    moveDir(canonical, parked);
  }
}

/** Remove what a fetch left in the temp folder, placed or not. */
export function discardFetched(fetched: FetchedSkill): void {
  fs.rmSync(fetched.workDir, { recursive: true, force: true });
}

/** Whether Deus's copy of skill `name` is on disk: where the agents load it, or set aside while it is switched off. */
export function skillFilesKept(name: string, id: string): boolean {
  return isSkillPlaced(name, id) || isOurs(path.join(disabledDir(), name), id);
}

/** Whether Deus's copy of skill `name` is where the agents load it. */
export function isSkillPlaced(name: string, id: string): boolean {
  return isOurs(path.join(agentsSkillsDir(), name), id);
}

/**
 * Skills on this computer that are not in Deus's list: the user's own, and
 * any folder Deus once placed whose install is gone (a reset database, a
 * skill the catalog dropped), so nothing the agents load is invisible.
 * `installed` says whether a Deus skill id still has an install.
 */
export function listLocalSkills(installed: (id: string) => boolean): LocalSkill[] {
  const found = new Map<string, LocalSkill>();
  const scan = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const skillDir = path.join(dir, entry.name);
      const skillMd = path.join(skillDir, "SKILL.md");
      const marker = readMarker(skillDir);
      if (!fs.existsSync(skillMd) || (marker && installed(marker.id))) continue;
      let description = "";
      try {
        const frontmatter = parseSkillFrontmatter(fs.readFileSync(skillMd, "utf8"));
        description = typeof frontmatter.description === "string" ? frontmatter.description : "";
      } catch {
        // unreadable: list it without a description
      }
      // In both folders it is one skill: the first found says what it is.
      if (!found.has(entry.name)) found.set(entry.name, { name: entry.name, description });
    }
  };
  scan(claudeSkillsDir());
  scan(agentsSkillsDir());
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_LISTED_FILES = 200;

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_LISTED_FILES) break;
    if (entry.name === MARKER || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
  return out;
}

/** Read the installed copy (placed or switched off), else SKILL.md from GitHub at the pin. */
export async function readSkillContent(
  name: string,
  id: string,
  source: SkillSource
): Promise<SkillContent> {
  assertSkillName(name);
  for (const dir of [path.join(agentsSkillsDir(), name), path.join(disabledDir(), name)]) {
    if (!isOurs(dir, id)) continue;
    return {
      markdown: fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"),
      files: listFiles(dir).sort(),
    };
  }
  const file = [source.path, "SKILL.md"].filter(Boolean).join("/");
  const response = await fetch(
    `https://raw.githubusercontent.com/${source.repo}/${encodeURIComponent(source.ref)}/${file}`,
    { headers: { "User-Agent": "Deus" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} for ${source.repo}/${file}`);
  return { markdown: await response.text(), files: null };
}
