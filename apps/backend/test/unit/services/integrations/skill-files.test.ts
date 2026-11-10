import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "./fixtures";

const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../../src/lib/database", () => ({
  get DB_PATH() {
    return `${state.dir}/data/deus.db`;
  },
}));

import { execFileSync } from "child_process";
import {
  agentsSkillsDir,
  claudeSkillsDir,
  discardFetched,
  fetchSkill,
  isSkillPlaced,
  listLocalSkills,
  parseSkillFrontmatter,
  parseSkillSource,
  placeSkill,
  placementConflict,
  removeSkill,
  setSkillPlaced,
} from "../../../../src/services/integrations/skill-files";

const SOURCE = { repo: "acme/skills", ref: "c".repeat(40), path: "skills/plan" };

function staged(name = "plan"): string {
  const dir = fs.mkdtempSync(path.join(state.dir, "staged-"));
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Plans work\n---\nBody`
  );
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo hi");
  return dir;
}

function writeForeignSkill(dir: string, name: string) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Mine\n---\n`
  );
}

beforeEach(() => {
  state.dir = scratchDir("deus-skills-");
  process.env.DEUS_SKILLS_HOME = state.dir;
});

afterEach(() => {
  delete process.env.DEUS_SKILLS_HOME;
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("placing a skill", () => {
  it("puts the files where Codex loads them and links them where Claude does", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    const canonical = path.join(agentsSkillsDir(), "plan");
    const link = path.join(claudeSkillsDir(), "plan");
    expect(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8")).toContain("name: plan");
    expect(fs.existsSync(path.join(canonical, "scripts", "run.sh"))).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(canonical));
    const marker = JSON.parse(fs.readFileSync(path.join(canonical, ".deus-skill.json"), "utf8"));
    expect(marker).toMatchObject({ installedBy: "deus", id: "acme/plan", ref: SOURCE.ref });
    expect(isSkillPlaced("plan", "acme/plan")).toBe(true);
  });

  it("never replaces a skill it did not install", () => {
    writeForeignSkill(claudeSkillsDir(), "plan");
    expect(placementConflict("plan", "acme/plan")).toMatch(/already in ~\/.claude\/skills/);
    expect(() =>
      placeSkill({
        id: "acme/plan",
        name: "plan",
        stagedDir: staged(),
        source: SOURCE,
        sha: SOURCE.ref,
      })
    ).toThrow(/already/);
    expect(fs.readFileSync(path.join(claudeSkillsDir(), "plan", "SKILL.md"), "utf8")).toContain(
      "Mine"
    );
  });

  it("two sources with the same skill name conflict instead of overwriting each other", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    expect(placementConflict("plan", "other/plan")).toMatch(/already/);
    // Reinstalling the same id replaces its own files.
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: "d".repeat(40),
    });
    const marker = JSON.parse(
      fs.readFileSync(path.join(agentsSkillsDir(), "plan", ".deus-skill.json"), "utf8")
    );
    expect(marker.ref).toBe("d".repeat(40));
  });

  it("switching off hides it from both agents; switching on brings it back", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    setSkillPlaced("plan", "acme/plan", false);
    expect(fs.existsSync(path.join(agentsSkillsDir(), "plan"))).toBe(false);
    expect(fs.existsSync(path.join(claudeSkillsDir(), "plan"))).toBe(false);
    setSkillPlaced("plan", "acme/plan", true);
    expect(isSkillPlaced("plan", "acme/plan")).toBe(true);
    expect(fs.existsSync(path.join(claudeSkillsDir(), "plan", "SKILL.md"))).toBe(true);
  });

  it("removing takes only its own files", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    writeForeignSkill(claudeSkillsDir(), "mine");
    removeSkill("acme/plan");
    expect(fs.existsSync(path.join(agentsSkillsDir(), "plan"))).toBe(false);
    expect(fs.existsSync(path.join(claudeSkillsDir(), "plan"))).toBe(false);
    expect(fs.existsSync(path.join(claudeSkillsDir(), "mine", "SKILL.md"))).toBe(true);
    removeSkill("acme/other");
    expect(fs.existsSync(path.join(claudeSkillsDir(), "mine", "SKILL.md"))).toBe(true);
  });

  it("a copy of our skill the user keeps in ~/.claude/skills is theirs", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    // The user replaced Claude's link with their own edited copy, marker and all.
    const link = path.join(claudeSkillsDir(), "plan");
    fs.unlinkSync(link);
    fs.cpSync(path.join(agentsSkillsDir(), "plan"), link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "---\nname: plan\n---\nMy edits");

    removeSkill("acme/plan");
    expect(fs.existsSync(path.join(agentsSkillsDir(), "plan"))).toBe(false);
    expect(fs.readFileSync(path.join(link, "SKILL.md"), "utf8")).toContain("My edits");
  });

  it("replacing a skill swaps the folder whole and leaves no staging behind", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    const next = staged();
    fs.writeFileSync(path.join(next, "NEW.md"), "new");
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: next,
      source: SOURCE,
      sha: "e".repeat(40),
    });
    const canonical = path.join(agentsSkillsDir(), "plan");
    expect(fs.existsSync(path.join(canonical, "NEW.md"))).toBe(true);
    expect(fs.readdirSync(agentsSkillsDir())).toEqual(["plan"]);
    // Claude's link still resolves to the new folder.
    expect(fs.existsSync(path.join(claudeSkillsDir(), "plan", "NEW.md"))).toBe(true);
  });

  it("lists the skills already on this computer, without Deus's own", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    writeForeignSkill(claudeSkillsDir(), "mine");
    writeForeignSkill(agentsSkillsDir(), "mine");
    writeForeignSkill(agentsSkillsDir(), "codex-only");
    const installed = (id: string) => id === "acme/plan";
    expect(listLocalSkills(installed)).toEqual([
      { name: "codex-only", description: "Mine", locations: ["agents"] },
      { name: "mine", description: "Mine", locations: ["claude", "agents"] },
    ]);
    // A folder Deus placed whose install is gone is listed too: nothing agents load is invisible.
    expect(listLocalSkills(() => false).map((skill) => skill.name)).toContain("plan");
  });

  it("two skills of one name never destroy each other, placed or switched off", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    setSkillPlaced("plan", "acme/plan", false); // parked
    expect(placementConflict("plan", "other/plan")).toMatch(/switched off/);
    expect(() =>
      placeSkill({
        id: "other/plan",
        name: "plan",
        stagedDir: staged(),
        source: SOURCE,
        sha: SOURCE.ref,
      })
    ).toThrow(/switched off/);
    // The first is intact and comes back.
    setSkillPlaced("plan", "acme/plan", true);
    expect(isSkillPlaced("plan", "acme/plan")).toBe(true);
  });

  it("removes its files by id wherever they are, even switched off", () => {
    placeSkill({
      id: "acme/plan",
      name: "plan",
      stagedDir: staged(),
      source: SOURCE,
      sha: SOURCE.ref,
    });
    setSkillPlaced("plan", "acme/plan", false);
    removeSkill("acme/plan");
    expect(() => setSkillPlaced("plan", "acme/plan", true)).toThrow(/missing/);
  });

  it("refuses an unsafe skill name", () => {
    expect(() =>
      placeSkill({
        id: "x",
        name: "../escape",
        stagedDir: staged(),
        source: SOURCE,
        sha: SOURCE.ref,
      })
    ).toThrow(/Invalid skill name/);
  });
});

describe("parsing", () => {
  it("reads GitHub links and short forms", () => {
    expect(parseSkillSource("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      repo: "anthropics/skills",
      ref: "main",
      path: "skills/pdf",
    });
    expect(parseSkillSource("https://github.com/o/r/blob/abc123/skills/x/SKILL.md")).toEqual({
      repo: "o/r",
      ref: "abc123",
      path: "skills/x",
    });
    expect(parseSkillSource("https://github.com/o/r")).toEqual({
      repo: "o/r",
      ref: "HEAD",
      path: "",
    });
    expect(parseSkillSource("o/r/skills/x")).toEqual({
      repo: "o/r",
      ref: "HEAD",
      path: "skills/x",
    });
    expect(() => parseSkillSource("not a link")).toThrow();
  });

  it("reads frontmatter, folded descriptions included", () => {
    expect(
      parseSkillFrontmatter("---\nname: pdf\ndescription: >\n  Read and\n  write PDFs\n---\nBody")
    ).toEqual({ name: "pdf", description: "Read and write PDFs\n" });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({});
  });
});

describe("fetching from GitHub", () => {
  const SHA = "f".repeat(40);

  /** A repository tarball as GitHub serves one: a single top folder named after the commit. */
  function serveRepo(build: (root: string) => void): void {
    const work = fs.mkdtempSync(path.join(state.dir, "repo-"));
    const root = path.join(work, `r-${SHA}`);
    fs.mkdirSync(root, { recursive: true });
    build(root);
    const tarball = path.join(work, "repo.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", work, `r-${SHA}`]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe(`https://codeload.github.com/o/r/tar.gz/${SHA}`);
      return new Response(fs.readFileSync(tarball));
    });
  }

  function skillAt(dir: string, name: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Does ${name}\n---\n`
    );
  }

  it("takes the skill's folder, dot-folders included, and leaves links behind", async () => {
    fs.writeFileSync(path.join(state.dir, "secret.txt"), "private");
    serveRepo((root) => {
      const skill = path.join(root, ".agents", "skills", "good");
      skillAt(skill, "good");
      fs.mkdirSync(path.join(skill, "scripts"));
      fs.writeFileSync(path.join(skill, "scripts", "run.sh"), "echo hi");
      fs.symlinkSync(path.join(state.dir, "secret.txt"), path.join(skill, "leak.txt"));
    });
    const fetched = await fetchSkill({ repo: "o/r", ref: SHA, path: ".agents/skills/good" });
    expect(fetched).toMatchObject({ name: "good", description: "Does good", sha: SHA, files: 2 });
    expect(fs.existsSync(path.join(fetched.dir, "scripts", "run.sh"))).toBe(true);
    expect(fs.existsSync(path.join(fetched.dir, "leak.txt"))).toBe(false);
    discardFetched(fetched);
    expect(fs.existsSync(fetched.workDir)).toBe(false);
  });

  it("refuses a path, or a linked folder, that leaves the repository", async () => {
    const outside = path.join(state.dir, "outside");
    skillAt(outside, "outside");
    serveRepo((root) => {
      skillAt(path.join(root, "skills", "good"), "good");
      fs.symlinkSync(outside, path.join(root, "skills", "linked"));
    });
    await expect(fetchSkill({ repo: "o/r", ref: SHA, path: "skills/linked" })).rejects.toThrow(
      /leaves the repository/
    );
    await expect(fetchSkill({ repo: "o/r", ref: SHA, path: "../.." })).rejects.toThrow(
      /No SKILL.md|leaves the repository/
    );
  });

  it("says when there is no skill at the path, and leaves nothing in the temp folder", async () => {
    serveRepo((root) => skillAt(path.join(root, "skills", "good"), "good"));
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("deus-skill-"));
    await expect(fetchSkill({ repo: "o/r", ref: SHA, path: "skills/missing" })).rejects.toThrow(
      /No SKILL.md at o\/r\/skills\/missing/
    );
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("deus-skill-"));
    expect(after).toEqual(before);
  });
});
