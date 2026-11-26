import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";
import { expect, it, onTestFinished } from "vitest";
import { createChat } from "../../../src/db";

it("keeps session inserts in createChat", () => {
  const src = path.resolve(import.meta.dirname, "../../../src");
  const insert =
    /\b(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+(?:main\s*\.\s*)?["'`[]?sessions\b/gi;
  const owners = globSync("**/*.{ts,tsx,js,cjs,mjs,sql}", { cwd: src }).flatMap((file) =>
    [...readFileSync(path.join(src, file), "utf8").matchAll(insert)].map(() => file)
  );
  expect(owners).toEqual([path.join("db", "queries.ts")]);
});

it("creates an idle chat and rolls its selection back with the caller's transaction", () => {
  const db = new Database(":memory:");
  onTestFinished(() => {
    db.close();
  });
  db.exec(SCHEMA_SQL);
  db.exec(`INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/repo');
           INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'ws')`);
  const origin = JSON.stringify({ kind: "session", sessionId: "lead" });
  db.transaction(() =>
    createChat(db, "w", {
      id: "first",
      harness: "codex-app-server",
      providerSessionId: "cloud",
      startedBy: origin,
    })
  )();
  const selected = () =>
    db.prepare("SELECT current_session_id FROM workspaces WHERE id = 'w'").pluck().get();
  expect(selected()).toBeNull();
  expect(db.prepare("SELECT * FROM sessions WHERE id = 'first'").get()).toMatchObject({
    status: "idle",
    updated_at: expect.any(String),
    agent_harness: "codex-app-server",
    provider_session_id: "cloud",
    started_by: origin,
  });
  expect(
    db.transaction(() => {
      const id = createChat(db, "w", { select: true });
      expect(selected()).toBe(id);
      throw new Error("rollback");
    })
  ).toThrow("rollback");
  expect(selected()).toBeNull();
  expect(db.prepare("SELECT id FROM sessions").pluck().all()).toEqual(["first"]);
});
