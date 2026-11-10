import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { memoryDatabase, scratchDir } from "./fixtures";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, dir: "" }));
vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/data/deus.db`;
  },
}));
vi.mock("../../../../src/services/query-engine", () => ({ invalidate: () => {} }));

import {
  codexSessionHome,
  codexTurnHome,
  pruneCodexSessionHomes,
} from "../../../../src/services/integrations/codex-homes";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-codex-homes-");
  // The user's own Codex home.
  const user = path.join(state.dir, "user-codex");
  fs.mkdirSync(path.join(user, "skills"), { recursive: true });
  fs.writeFileSync(path.join(user, "auth.json"), "{}");
  fs.writeFileSync(path.join(user, "config.toml"), 'model = "x"\n');
  fs.writeFileSync(path.join(user, "skills", "mine.md"), "mine");
  process.env.CODEX_HOME = user;
  state.db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/tmp/repo');
    INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'workspace');
    INSERT INTO sessions (id, workspace_id) VALUES ('live', 'w'), ('idle', 'w');
  `);
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  state.db?.close();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("Codex session homes", () => {
  it("share the user's login and skills by link, start from a copy of their config, and stay private", () => {
    const home = codexSessionHome("live");
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(home, "skills")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(home, "config.toml")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe('model = "x"\n');
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    // The user's history is not linked: a fresh home would index all of it before answering.
    expect(fs.existsSync(path.join(home, "sessions"))).toBe(false);
    expect(codexSessionHome("live")).toBe(home);
  });

  it("a chat gets a home at its first turn once an app is installed, and keeps it", () => {
    // No app installed: the user's own home, where their Codex finds the thread.
    expect(codexTurnHome("plain", { resumes: false, appsInstalled: false })).toBeNull();
    // A thread that began there resumes there, whatever is installed since.
    expect(codexTurnHome("plain", { resumes: true, appsInstalled: true })).toBeNull();
    // An app installed, signed in or not: a home of its own, kept from then on.
    const home = codexTurnHome("with-apps", { resumes: false, appsInstalled: true });
    expect(home).toBe(codexSessionHome("with-apps"));
    expect(codexTurnHome("with-apps", { resumes: true, appsInstalled: false })).toBe(home);
  });

  it("refuses an id that is not a plain name", () => {
    expect(() => codexSessionHome("../escape")).toThrow(/Invalid session id/);
  });

  it("removes the home of a deleted session, and never the user's files behind its links", () => {
    const home = codexSessionHome("gone");
    expect(pruneCodexSessionHomes()).toBe(1);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readFileSync(path.join(state.dir, "user-codex", "skills", "mine.md"), "utf8")).toBe(
      "mine"
    );
    expect(fs.existsSync(path.join(state.dir, "user-codex", "auth.json"))).toBe(true);
  });

  it("gives an idle session's regenerable caches back and keeps its thread", () => {
    for (const id of ["live", "idle"]) {
      const home = codexSessionHome(id);
      fs.mkdirSync(path.join(home, "cache"));
      fs.writeFileSync(path.join(home, "cache", "blob"), "x".repeat(1000));
      fs.mkdirSync(path.join(home, "plugins"));
      fs.mkdirSync(path.join(home, "sessions"));
      fs.writeFileSync(path.join(home, "sessions", "rollout.jsonl"), "{}");
    }
    const idle = codexSessionHome("idle");
    const old = new Date(Date.now() - 4 * DAY);
    fs.utimesSync(path.join(idle, ".deus-codex-home"), old, old);

    expect(pruneCodexSessionHomes()).toBe(1);
    expect(fs.existsSync(path.join(idle, "cache"))).toBe(false);
    expect(fs.existsSync(path.join(idle, "plugins"))).toBe(false);
    expect(fs.existsSync(path.join(idle, "sessions", "rollout.jsonl"))).toBe(true);
    // Its `skills` is a link to the user's: untouched.
    expect(fs.existsSync(path.join(state.dir, "user-codex", "skills", "mine.md"))).toBe(true);
    // The session in use keeps everything.
    expect(fs.existsSync(path.join(codexSessionHome("live"), "cache", "blob"))).toBe(true);
    // Using the idle one again counts as use.
    codexSessionHome("idle");
    expect(pruneCodexSessionHomes()).toBe(0);
  });
});
