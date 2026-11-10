import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { memoryDatabase, scratchDir, testCatalog } from "./fixtures";

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dir: "",
  invalidations: 0,
  ghToken: "gho_cli_token" as string | null,
  ghCalls: 0,
  failFetch: null as string | null,
}));

vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));
vi.mock("../../../../src/services/query-engine", () => ({
  invalidate: () => {
    state.invalidations += 1;
  },
}));
vi.mock("../../../../src/services/gh.service", () => ({
  runGh: async () => {
    state.ghCalls += 1;
    return state.ghToken
      ? { success: true, stdout: state.ghToken }
      : { success: false, error: "gh_not_authenticated", message: "not signed in" };
  },
}));
vi.mock("@shared/integrations/catalog", async () => {
  const { testCatalog: catalog } = await import("./fixtures");
  return { CATALOG: catalog() };
});
// Probing would reach the network: answer for the server instead.
vi.mock("../../../../src/services/integrations/probe", () => ({
  probeServer: async () => ({
    ok: true,
    tools: [{ name: "list_issues", description: "List issues", readOnly: true }],
    unauthorized: false,
    error: null,
  }),
}));
// Skill downloads are covered in skills.test.ts.
vi.mock("../../../../src/services/integrations/skill-files", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/services/integrations/skill-files")>();
  return {
    ...actual,
    fetchSkill: async () => {
      if (state.failFetch) throw new Error(state.failFetch);
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

import { composeSnapshot } from "@shared/integrations/compose";
import {
  getState,
  proxyMcp,
  resolveCloudTurnExtensions,
  resolveTurnApps,
  startIntegrations,
} from "../../../../src/services/integrations";
import {
  connectApp,
  disconnectApp,
  installApp,
  setAppEnabled,
  uninstallApp,
} from "../../../../src/services/integrations/apps";
import { __gatewayKeyForTests, GATEWAY_PATH } from "../../../../src/services/integrations/gateway";
import { installPlugin, uninstallPlugin } from "../../../../src/services/integrations/plugins";
import {
  installSkill,
  reinstallSkill,
  resumeSkillInstalls,
  setSkillEnabled,
  settleSkillJobs,
  uninstallSkill,
} from "../../../../src/services/integrations/skills";
import { credentialsFor } from "../../../../src/services/integrations/credentials";
import { settleChecks } from "../../../../src/services/integrations/checks";
import { markNeedsReauth } from "../../../../src/services/integrations/events";
import {
  getConnection,
  getInstallation,
  readAppTools,
  upsertInstallation,
} from "../../../../src/services/integrations/store";
import { __resetVaultKeyForTests } from "../../../../src/services/integrations/vault";
import { __resetCredentialCacheForTests } from "../../../../src/services/integrations/credentials";

const PORT = 4100;

beforeEach(() => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-integrations-");
  state.invalidations = 0;
  state.ghToken = "gho_cli_token";
  state.ghCalls = 0;
  state.failFetch = null;
  process.env.DEUS_VAULT_KEY = "11".repeat(32);
  process.env.DEUS_SKILLS_HOME = state.dir;
  delete process.env.DEUS_CLOUD_EXTENSIONS;
  __resetVaultKeyForTests();
  __resetCredentialCacheForTests();
  startIntegrations(PORT);
});

afterEach(async () => {
  await settleChecks();
  await settleSkillJobs();
  state.db?.close();
  delete process.env.DEUS_SKILLS_HOME;
});

const snapshot = () => composeSnapshot(testCatalog(), getState());
const app = (id: string) => snapshot().apps.find((v) => v.app.id === id)!;
const skill = (id: string) => snapshot().skills.find((v) => v.skill.id === id)!;
const gateway = (id: string) => ({
  type: "http",
  url: `http://127.0.0.1:${PORT}${GATEWAY_PATH}/${id}`,
  headers: { Authorization: `Bearer ${__gatewayKeyForTests()}` },
  required: false,
});

describe("apps", () => {
  it("pushes state only: nothing installed is a few bytes, however large the catalog", () => {
    const pushed = getState();
    expect(pushed).toMatchObject({ apps: [], skills: [], plugins: [] });
    expect(JSON.stringify(pushed).length).toBeLessThan(300);
    expect(app("linear").readiness).toBe("not_installed");
  });

  it("an app that needs no account is ready once installed, and is named directly", async () => {
    installApp("context7");
    expect(app("context7").readiness).toBe("ready");
    const { servers } = await resolveTurnApps();
    expect(servers.context7).toEqual({
      type: "http",
      url: "https://mcp.context7.test/mcp",
      required: false,
    });
  });

  it("installing is not authorizing: an OAuth app waits for its account and stays out of turns", async () => {
    installApp("linear");
    expect(app("linear").readiness).toBe("needs_connection");
    const { servers, skipped } = await resolveTurnApps();
    expect(servers.linear).toBeUndefined();
    expect(skipped).toContainEqual({ appId: "linear", reason: "Not connected" });
  });

  it("a pasted token is sealed at rest, and a turn names the gateway, never the token", async () => {
    expect(await connectApp({ appId: "sentry", values: { token: "sntrys_secret" } })).toEqual({
      status: "connected",
    });
    expect(app("sentry")).toMatchObject({ installed: true, readiness: "ready" });

    const raw = state.db!.prepare("SELECT credential FROM integration_connections").get() as {
      credential: string;
    };
    expect(raw.credential).not.toContain("sntrys_secret");

    const turn = await resolveTurnApps();
    expect(turn.servers.sentry).toEqual(gateway("sentry"));
    expect(JSON.stringify(turn)).not.toContain("sntrys_secret");

    // The gateway is what holds it, per request.
    const row = getInstallation("app", "sentry")!;
    const credentials = await credentialsFor(app("sentry").app, getConnection(row.connectionId!));
    expect(credentials).toMatchObject({
      ok: true,
      headers: { Authorization: "Bearer sntrys_secret" },
    });
  });

  it("nothing a client reads carries a credential", async () => {
    await connectApp({ appId: "sentry", values: { token: "sntrys_secret" } });
    await settleChecks();
    expect(JSON.stringify(getState())).not.toContain("sntrys_secret");
    expect(JSON.stringify(readAppTools("sentry"))).not.toContain("sntrys_secret");
  });

  it("a local server gets its variables in its environment", async () => {
    await connectApp({ appId: "exa", values: { EXA_API_KEY: "exa-key" } });
    const { servers } = await resolveTurnApps();
    expect(servers.exa).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "exa-mcp-server"],
      env: { EXA_API_KEY: "exa-key" },
      required: false,
    });
  });

  it("rejects a missing required variable", async () => {
    await expect(connectApp({ appId: "exa", values: {} })).rejects.toThrow("API key is required");
  });

  it("a switched-off app stays installed but leaves turns", async () => {
    installApp("context7");
    setAppEnabled("context7", false);
    expect(app("context7").readiness).toBe("disabled");
    expect((await resolveTurnApps()).servers.context7).toBeUndefined();
  });

  it("says an app is installed while it is switched off: a Codex chat begun then still gets it later", async () => {
    expect((await resolveTurnApps()).installed).toBe(false);
    installApp("linear");
    setAppEnabled("linear", false);
    expect(await resolveTurnApps()).toMatchObject({ servers: {}, skipped: [], installed: true });
  });

  it("signing out keeps the app; removing the app forgets its account", async () => {
    await connectApp({ appId: "sentry", values: { token: "t1" } });
    await disconnectApp("sentry");
    expect(app("sentry")).toMatchObject({ installed: true, readiness: "needs_connection" });

    await connectApp({ appId: "sentry", values: { token: "t2" } });
    uninstallApp("sentry");
    expect(app("sentry").installed).toBe(false);
    // No credential stays where no view shows it.
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM integration_connections").get()).toEqual({
      n: 0,
    });
    installApp("sentry");
    expect(app("sentry").readiness).toBe("needs_connection");
  });

  it("a new key replaces the old account", async () => {
    await connectApp({ appId: "sentry", values: { token: "t1" } });
    await connectApp({ appId: "sentry", values: { token: "t2" } });
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM integration_connections").get()).toEqual({
      n: 1,
    });
    const row = getInstallation("app", "sentry")!;
    expect(await credentialsFor(app("sentry").app, getConnection(row.connectionId!))).toMatchObject(
      { headers: { Authorization: "Bearer t2" } }
    );
  });

  it("the check records the tools on the app; its page reads them on demand", async () => {
    installApp("context7");
    await settleChecks();
    expect(app("context7")).toMatchObject({ toolCount: 1, checkError: null });
    expect(readAppTools("context7")).toEqual([
      { name: "list_issues", description: "List issues", readOnly: true },
    ]);
    // The pushed state carries the count, not the list.
    expect(JSON.stringify(getState())).not.toContain("List issues");
  });

  it("GitHub CLI login: the token is read from the CLI, never stored, and reused briefly", async () => {
    await connectApp({ appId: "github", values: { fromCli: "gh" } });
    expect(app("github")).toMatchObject({ readiness: "ready" });
    expect(app("github").connection?.label).toBe("GitHub CLI login");
    expect(app("github").connection?.kind).toBe("cli");
    // Nothing is stored for it at all.
    expect(state.db!.prepare("SELECT kind, credential FROM integration_connections").get()).toEqual(
      { kind: "cli", credential: null }
    );
    expect((await resolveTurnApps()).servers.github).toEqual(gateway("github"));

    const connection = () => getConnection(getInstallation("app", "github")!.connectionId!);
    const github = app("github").app;
    const calls = state.ghCalls;
    expect(await credentialsFor(github, connection())).toMatchObject({
      headers: { Authorization: "Bearer gho_cli_token" },
    });
    expect(await credentialsFor(github, connection())).toMatchObject({ ok: true });
    expect(state.ghCalls - calls).toBeLessThanOrEqual(1);

    // A server that refused the token asks the CLI again.
    state.ghToken = "gho_rotated";
    expect(await credentialsFor(github, connection(), { fresh: true })).toMatchObject({
      headers: { Authorization: "Bearer gho_rotated" },
    });
    state.ghToken = null;
    expect(await credentialsFor(github, connection(), { fresh: true })).toMatchObject({
      ok: false,
      reauth: true,
    });
  });

  it("an account that needs the user says so to every open client, and a CLI login comes back by itself", async () => {
    await connectApp({ appId: "github", values: { fromCli: "gh" } });
    await settleChecks();
    await Promise.resolve();
    const connection = () => getConnection(getInstallation("app", "github")!.connectionId!);
    const before = state.invalidations;

    state.ghToken = null; // gh auth logout
    markNeedsReauth(connection()!.id, "The GitHub CLI is not signed in");
    await Promise.resolve();
    expect(state.invalidations).toBe(before + 1);
    expect(app("github").readiness).toBe("needs_reauth");
    expect((await resolveTurnApps()).servers.github).toBeUndefined();

    state.ghToken = "gho_back"; // gh auth login, outside Deus
    // The next turn has the app again, with no visit to Customize.
    expect((await resolveTurnApps()).servers.github).toBeDefined();
    expect(app("github").readiness).toBe("ready");
    expect(await credentialsFor(app("github").app, connection())).toMatchObject({
      ok: true,
      headers: { Authorization: "Bearer gho_back" },
    });
  });

  it("only GitHub can borrow a CLI login", async () => {
    await expect(connectApp({ appId: "sentry", values: { fromCli: "gh" } })).rejects.toThrow(
      /Paste your auth token/
    );
  });

  it("a server that accepts only vendor-approved clients waits for Deus's client", async () => {
    // No client of Deus's own, and no broker serves it: nothing can sign it in yet.
    expect(app("voicebox")).toMatchObject({ available: false, unavailable: "soon" });
    await expect(connectApp({ appId: "voicebox" })).rejects.toThrow(/coming soon/);
    expect(app("voicebox").installed).toBe(false);
    installApp("voicebox");
    expect(app("voicebox").readiness).toBe("unavailable");
    // One a broker serves waits for the person's Deus account instead.
    expect(app("slack")).toMatchObject({ available: false, unavailable: "account" });
  });

  it("an app that connects through the Deus account waits for one (see cloud-accounts.test.ts)", async () => {
    installApp("instagram");
    expect(app("instagram")).toMatchObject({
      readiness: "unavailable",
      unavailable: "account",
      via: null,
    });
    await expect(connectApp({ appId: "instagram" })).rejects.toThrow(
      /Sign in to your Deus account/
    );
    expect((await resolveTurnApps()).servers.instagram).toBeUndefined();
  });
});

describe("plugins", () => {
  it("installs its parts by reference and removes only what nothing else needs", async () => {
    installApp("context7"); // the user's own install
    installPlugin("ship");
    await settleSkillJobs();

    const plugin = snapshot().plugins.find((p) => p.plugin.id === "ship")!;
    expect(plugin.installed).toBe(true);
    expect(plugin.appsNeedingConnection).toEqual(["linear"]);
    // A part the plugin brought in is the plugin's; one the user installed stays theirs.
    expect(app("linear").installed).toBe(true);
    expect(getInstallation("app", "linear")?.explicit).toBe(false);
    expect(getInstallation("app", "context7")?.explicit).toBe(true);
    expect(skill("acme/plan").readiness).toBe("ready");

    uninstallPlugin("ship");
    expect(app("linear").installed).toBe(false);
    expect(app("context7").installed).toBe(true);
    expect(skill("acme/plan").installed).toBe(false);
  });

  it("an item two plugins share stays until the last one goes", async () => {
    installPlugin("ship");
    installPlugin("triage");
    await settleSkillJobs();
    uninstallPlugin("ship");
    expect(app("linear").installed).toBe(true);
    expect(app("context7").installed).toBe(false);
    uninstallPlugin("triage");
    expect(app("linear").installed).toBe(false);
  });

  it("an app the user connected is theirs: removing the plugin keeps it", async () => {
    installPlugin("triage");
    await connectApp({ appId: "sentry", values: { token: "t" } });
    uninstallPlugin("triage");
    expect(app("sentry")).toMatchObject({ installed: true, readiness: "ready" });
    expect(app("linear").installed).toBe(false);
  });
});

describe("skills", () => {
  it("installs in the background and records the commit on disk", async () => {
    installSkill("acme/plan");
    expect(skill("acme/plan").readiness).toBe("installing");
    await settleSkillJobs();
    expect(skill("acme/plan")).toMatchObject({
      readiness: "ready",
      installedRef: "b".repeat(40),
      // The catalog pins another commit than the one on disk.
      updateAvailable: true,
    });
  });

  it("a failed update keeps the working version, says why, and can still be switched off", async () => {
    const fs = await import("fs");
    installSkill("acme/plan");
    await settleSkillJobs();
    state.failFetch = "offline";
    reinstallSkill("acme/plan");
    await settleSkillJobs();
    expect(skill("acme/plan")).toMatchObject({ readiness: "ready", installedRef: "b".repeat(40) });
    expect(skill("acme/plan").error).toMatch(/Update failed: offline/);

    setSkillEnabled("acme/plan", false);
    expect(skill("acme/plan").readiness).toBe("disabled");
    expect(fs.existsSync(`${state.dir}/.agents/skills/plan`)).toBe(false);
    expect(fs.existsSync(`${state.dir}/.claude/skills/plan`)).toBe(false);
  });

  it("an update Deus quit in the middle of, resumed and failing, keeps the working version", async () => {
    installSkill("acme/plan");
    await settleSkillJobs();
    // What a quit mid-update leaves: the row says installing, the old files are in place.
    upsertInstallation({ kind: "skill", itemId: "acme/plan", status: "installing" });
    state.failFetch = "offline";
    resumeSkillInstalls();
    await settleSkillJobs();
    expect(skill("acme/plan")).toMatchObject({ readiness: "ready", installedRef: "b".repeat(40) });
    expect(skill("acme/plan").error).toMatch(/Update failed: offline/);
  });

  it("an update that fails over files that are gone says so, not that the skill is ready", async () => {
    const fs = await import("fs");
    installSkill("acme/plan");
    await settleSkillJobs();
    // Its folder is gone (a swap cut short, or removed by hand).
    fs.rmSync(`${state.dir}/.agents/skills/plan`, { recursive: true, force: true });
    state.failFetch = "offline";
    reinstallSkill("acme/plan");
    await settleSkillJobs();
    expect(skill("acme/plan").readiness).toBe("error");
    expect(skill("acme/plan").error).toBe("offline");
  });

  it("removing a skill while it downloads leaves nothing behind", async () => {
    const fs = await import("fs");
    installSkill("acme/plan");
    uninstallSkill("acme/plan");
    await settleSkillJobs();
    expect(skill("acme/plan").installed).toBe(false);
    expect(fs.existsSync(`${state.dir}/.agents/skills/plan`)).toBe(false);
    expect(fs.readdirSync(state.dir).filter((name) => name.startsWith("fetch-"))).toEqual([]);
  });

  it("cloud turns carry the complete skill set, [] included, only once the platform takes it", async () => {
    expect(await resolveCloudTurnExtensions()).toEqual({});
    process.env.DEUS_CLOUD_EXTENSIONS = "1";
    expect(await resolveCloudTurnExtensions()).toEqual({ skills: [] });
    installSkill("acme/plan");
    await settleSkillJobs();
    expect(await resolveCloudTurnExtensions()).toEqual({
      skills: [{ name: "plan", repo: "acme/skills", ref: "b".repeat(40), path: "skills/plan" }],
    });
  });

  it("a cloud turn carries public servers, and nothing whose account or process is on this computer", async () => {
    process.env.DEUS_CLOUD_EXTENSIONS = "1";
    installApp("context7"); // a public remote server
    installApp("playwright"); // runs on this computer
    await connectApp({ appId: "sentry", values: { token: "secret-token" } }); // a key held here
    const turn = await resolveCloudTurnExtensions();
    expect(turn.mcpServers).toEqual({
      context7: { type: "http", url: "https://mcp.context7.test/mcp", required: false },
    });
    expect(JSON.stringify(turn)).not.toContain("secret-token");
    expect(app("context7").cloud).toBe(true);
    expect(app("sentry").cloud).toBe(false);
    expect(app("playwright").cloud).toBe(false);
    // Switched off, it leaves cloud turns too.
    setAppEnabled("context7", false);
    expect((await resolveCloudTurnExtensions()).mcpServers).toBeUndefined();
    expect(app("context7").cloud).toBe(false);
  });
});

describe("pushes", () => {
  it("a burst of changes is one push", async () => {
    installPlugin("ship");
    expect(state.invalidations).toBe(0);
    await Promise.resolve();
    expect(state.invalidations).toBe(1);
  });

  it("a pasted key its server refuses tells every open client, like any other account", async () => {
    await connectApp({ appId: "sentry", values: { token: "revoked-key" } });
    await settleChecks();
    await Promise.resolve();
    const before = state.invalidations;
    // The key was revoked at Sentry: its server answers 401, twice.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 401 })
    );
    const answer = await proxyMcp(
      "sentry",
      new Request("http://127.0.0.1/api/integrations/mcp/sentry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      })
    );
    expect(await answer.json()).toMatchObject({ id: 1, error: { message: /not connected/ } });
    await Promise.resolve();
    expect(app("sentry").readiness).toBe("needs_reauth");
    expect(state.invalidations).toBe(before + 1);
  });
});
