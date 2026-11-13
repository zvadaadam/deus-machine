// The Customize operations, called the way a client's frame does: through
// validation to the handler, against the real services and an in-memory
// database. What each service does in depth is in services/integrations/.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import * as api from "@shared/api/integrations";
import { operations } from "../../helpers";
import { memoryDatabase, scratchDir, testCatalog } from "../services/integrations/fixtures";

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dir: "",
  probes: 0,
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: () => {} }));
vi.mock("@shared/integrations/catalog", async () => {
  const { testCatalog: catalog } = await import("../services/integrations/fixtures");
  return { CATALOG: catalog() };
});
// Probing would reach the network: answer for the server instead.
vi.mock("../../../src/services/integrations/probe", () => ({
  probeServer: async () => {
    state.probes += 1;
    return {
      ok: true,
      tools: [{ name: "list_issues", description: "List issues", readOnly: true }],
      unauthorized: false,
      error: null,
    };
  },
}));
// So would downloading a skill: stage one on disk instead.
vi.mock("../../../src/services/integrations/skill-files", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/services/integrations/skill-files")>();
  return {
    ...actual,
    fetchSkill: async () => {
      const fs = await import("fs");
      const path = await import("path");
      const work = fs.mkdtempSync(path.join(state.dir, "fetch-"));
      const staged = path.join(work, "skill");
      fs.mkdirSync(staged);
      fs.writeFileSync(path.join(staged, "SKILL.md"), "---\nname: plan\ndescription: Plans\n---\n");
      return {
        dir: staged,
        workDir: work,
        sha: "b".repeat(40),
        name: "plan",
        description: "Plans",
        files: 1,
      };
    },
  };
});

import handlers from "../../../src/api/integrations";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { startIntegrations } from "../../../src/services/integrations";
import { settleChecks } from "../../../src/services/integrations/checks";
import { settleSkillJobs } from "../../../src/services/integrations/skills";
import { __resetVaultKeyForTests } from "../../../src/services/integrations/vault";
import { __resetCredentialCacheForTests } from "../../../src/services/integrations/credentials";

const run = operations(handlers);
const installed = async () => {
  const { apps, skills, plugins } = await run(api.integrations);
  return { apps: apps.map((a) => a.id), skills: skills.map((s) => s.id), plugins };
};

beforeEach(async () => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-integrations-api-");
  state.probes = 0;
  process.env.DEUS_VAULT_KEY = "11".repeat(32);
  process.env.DEUS_SKILLS_HOME = state.dir;
  delete process.env.DEUS_CLOUD_EXTENSIONS;
  __resetVaultKeyForTests();
  __resetCredentialCacheForTests();
  await startIntegrations(4100);
});

afterEach(async () => {
  await settleChecks();
  await settleSkillJobs();
  state.db?.close();
  delete process.env.DEUS_SKILLS_HOME;
});

describe("reads", () => {
  it("the catalog is one read, what is installed another, and neither repeats the other", async () => {
    expect(await run(api.integrationsCatalog)).toEqual(testCatalog());
    expect(await run(api.integrations)).toMatchObject({
      catalogVersion: "test",
      apps: [],
      skills: [],
      plugins: [],
    });
    expect(await run(api.localSkills)).toEqual([]);
  });

  it("answers a subscriber in the same tick", () => {
    const pushed = new Registry(handlers).runLive("integrations", {}, { caller: LOCAL_CALLER });
    expect(pushed).not.toBeInstanceOf(Promise);
    expect(pushed).toMatchObject({ catalogVersion: "test" });
  });

  it("an app's tools and a skill's page name which one they are for", async () => {
    await expect(run(api.appTools, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "appTools requires appId",
    });
    await expect(run(api.skillContent, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "skillContent requires skillId",
    });
    await expect(run(api.skillContent, { skillId: "nope" })).rejects.toThrow("Unknown skill: nope");
    // Never checked: nothing listed, and no failure either.
    expect(await run(api.appTools, { appId: "linear" })).toEqual([]);
  });
});

describe("install, remove, switch", () => {
  it("installs and removes the kind it is given", async () => {
    expect(await run(api.installIntegration, { kind: "app", id: "context7" })).toBeUndefined();
    await run(api.installIntegration, { kind: "skill", id: "acme/plan" });
    await run(api.installIntegration, { kind: "plugin", id: "triage" });
    expect(await installed()).toEqual({
      apps: expect.arrayContaining(["context7", "linear", "sentry"]),
      skills: ["acme/plan"],
      plugins: ["triage"],
    });

    // The plugin takes the two apps it brought; the app the person installed stays.
    expect(await run(api.uninstallIntegration, { kind: "plugin", id: "triage" })).toBeUndefined();
    expect(await installed()).toEqual({ apps: ["context7"], skills: ["acme/plan"], plugins: [] });
    await run(api.uninstallIntegration, { kind: "skill", id: "acme/plan" });
    await run(api.uninstallIntegration, { kind: "app", id: "context7" });
    expect(await installed()).toEqual({ apps: [], skills: [], plugins: [] });
  });

  it("refuses a kind it does not know, and an id of the wrong kind", async () => {
    await expect(
      run(api.installIntegration, { kind: "theme", id: "context7" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(api.installIntegration, { kind: "app" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "installIntegration requires id",
    });
    await expect(run(api.installIntegration, { kind: "skill", id: "context7" })).rejects.toThrow(
      "Unknown skill: context7"
    );
    expect(await installed()).toEqual({ apps: [], skills: [], plugins: [] });
  });

  it("switches an app or a skill off and on; a plugin has no switch", async () => {
    await run(api.installIntegration, { kind: "plugin", id: "ship" });
    await settleSkillJobs();

    await run(api.setIntegrationEnabled, { kind: "app", id: "context7", enabled: false });
    await run(api.setIntegrationEnabled, { kind: "skill", id: "acme/plan", enabled: false });
    const off = await run(api.integrations);
    expect(off.apps.find((a) => a.id === "context7")?.enabled).toBe(false);
    expect(off.skills.find((s) => s.id === "acme/plan")?.enabled).toBe(false);

    await run(api.setIntegrationEnabled, { kind: "app", id: "context7", enabled: true });
    expect((await run(api.integrations)).apps.find((a) => a.id === "context7")?.enabled).toBe(true);

    await expect(
      run(api.setIntegrationEnabled, { kind: "plugin", id: "ship", enabled: false })
    ).rejects.toThrow("A plugin is installed or not; switch its apps and skills instead");
    // Leaving `enabled` out is refused: it is not read as "off".
    await expect(
      run(api.setIntegrationEnabled, { kind: "app", id: "context7" } as never)
    ).rejects.toMatchObject({ statusCode: 400, message: "setIntegrationEnabled requires enabled" });
    expect((await run(api.integrations)).apps.find((a) => a.id === "context7")?.enabled).toBe(true);
  });
});

describe("accounts", () => {
  it("connects with a pasted key, checks, lists the tools, and signs out", async () => {
    expect(
      await run(api.connectApp, { appId: "sentry", values: { token: "sntrys_secret" } })
    ).toEqual({ status: "connected" });
    await settleChecks();
    const probes = state.probes;

    // The check is awaited: its result is there when the write answers.
    expect(await run(api.checkApp, { appId: "sentry" })).toBeUndefined();
    expect(state.probes).toBe(probes + 1);
    expect(await run(api.appTools, { appId: "sentry" })).toEqual([
      { name: "list_issues", description: "List issues", readOnly: true },
    ]);
    const connected = (await run(api.integrations)).apps.find((a) => a.id === "sentry");
    expect(connected).toMatchObject({ toolCount: 1, connection: { kind: "secret" } });
    expect(JSON.stringify(connected)).not.toContain("sntrys_secret");

    expect(await run(api.disconnectApp, { appId: "sentry" })).toBeUndefined();
    expect((await run(api.integrations)).apps.find((a) => a.id === "sentry")).toMatchObject({
      id: "sentry",
      connection: null,
    });
  });

  it("refuses a connect that names no app, or carries a value too long to be a key", async () => {
    await expect(run(api.connectApp, { values: { token: "t" } } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "connectApp requires appId",
    });
    await expect(
      run(api.connectApp, { appId: "sentry", values: { token: "x".repeat(8193) } })
    ).rejects.toMatchObject({ statusCode: 400 });
    // What the service refuses keeps the service's words.
    await expect(run(api.connectApp, { appId: "sentry", values: {} })).rejects.toThrow(
      "Paste your auth token"
    );
  });
});

describe("the person's own", () => {
  it("adds a server as an app, named after it, and says which app it became", async () => {
    const added = await run(api.addCustomApp, {
      name: "  My Server ",
      transport: { type: "stdio", command: "node" },
      auth: { kind: "none" },
    });
    expect(added).toEqual({ appId: "my-server" });
    const app = (await run(api.integrations)).apps.find((a) => a.id === "my-server");
    expect(app?.definition).toMatchObject({
      name: "My Server",
      publisher: "You",
      transport: { type: "stdio", command: "node", args: [] },
      local: true,
    });

    await expect(
      run(api.addCustomApp, {
        name: "",
        transport: { type: "http", url: "https://mcp.example.test/mcp" },
        auth: { kind: "none" },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("adds a skill from a link once it is downloaded, shows its page, and downloads it again", async () => {
    const added = await run(api.addCustomSkill, { source: " acme/extra " });
    expect(added).toEqual({ skillId: "custom/acme/extra/plan" });
    expect((await run(api.integrations)).skills).toMatchObject([
      { id: "custom/acme/extra/plan", status: "ready", installedRef: "b".repeat(40) },
    ]);
    expect(await run(api.skillContent, added)).toEqual({
      markdown: "---\nname: plan\ndescription: Plans\n---\n",
      files: ["SKILL.md"],
    });

    expect(await run(api.updateSkill, added)).toBeUndefined();
    expect((await run(api.integrations)).skills[0]?.status).toBe("installing");
    await settleSkillJobs();
    expect((await run(api.integrations)).skills[0]?.status).toBe("ready");

    await expect(run(api.updateSkill, { skillId: "acme/plan" })).rejects.toThrow(
      "Add the skill first"
    );
    await expect(run(api.addCustomSkill, { source: "x" })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
