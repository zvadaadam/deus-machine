// Cloud workspaces in two organizations of one account, on one Mac. The real backend
// holds one key per organization (what the desktop app hands it) and the platform's
// session sockets. The scripted platform (./platform.mjs) refuses an
// organization-scoped request that carries another organization's key.
// No browser: the backend is driven over its own socket (test/e2e/lib/operations.mjs).
// Run: bun run test:e2e:cloud   (or node --import tsx test/e2e/cloud/organizations.runtime.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../../shared/schema.ts";
import { connectBackend } from "../lib/operations.mjs";
import { startPlatform, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/organizations");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const BEARER = "bearer-orgs";
const ORG_A = { id: "org_acme", name: "Acme", key: "agnt_sk_acme", sessions: ["ses_a"] };
const ORG_B = { id: "org_beta", name: "Beta", key: "agnt_sk_beta", sessions: ["ses_b", "ses_old"] };
// Three cloud workspaces: one in each organization, and one whose row names none (made
// with a developer key, or adopted). It is read as the default's (Acme); the platform
// says it is Beta's, and its snapshot corrects it.
const rows = [
  { id: crypto.randomUUID(), session: crypto.randomUUID(), provider: "ses_a", org: ORG_A.id },
  { id: crypto.randomUUID(), session: crypto.randomUUID(), provider: "ses_b", org: ORG_B.id },
  { id: crypto.randomUUID(), session: crypto.randomUUID(), provider: "ses_old", org: null },
];
const [inA, inB, legacy] = rows;
const orgOf = (provider) => [ORG_A, ORG_B].find((o) => o.sessions.includes(provider)).id;
// What the backend asks the platform for that this journey does not serve. Each is
// answered 404 and the backend carries on; a request not listed here fails the run.
const UNSERVED = new Set([
  // Each keyed organization's automations, mirrored when credentials arrive.
  `GET /dashboard/orgs/${ORG_A.id}/automations`,
  `GET /dashboard/orgs/${ORG_B.id}/automations`,
]);

const platform = await startPlatform({
  bearer: BEARER,
  orgs: [ORG_A, ORG_B],
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: orgOf(id),
      workspaceId: `wsp_${id}`,
      status: "ready",
      sandboxUrlTemplate: null,
      currentTurnId: null,
    },
    messages: [],
    events: [],
  }),
});

// ---- This computer: a database with the three cloud workspaces, and the real backend --
const repository = crypto.randomUUID();
const repo = path.join(directory, "repository");
await mkdir(repo);
// Its own repository, with no remote: nothing here has a GitHub token to refresh.
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Orgs', ?)").run(
  repository,
  repo
);
for (const row of rows) {
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, provider_workspace_id, organization_id) VALUES (?, ?, ?, ?, 'ready', 'completed', ?, ?, 'main', 'cloud', ?, ?)"
  ).run(
    row.id,
    repository,
    row.provider,
    row.provider,
    row.session,
    row.provider,
    `wsp_${row.provider}`,
    row.org
  );
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
  ).run(row.session, row.id, row.provider);
}
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({ onboarding_completed: true })
);
// The platform is the only cloud this backend may reach, and it has no key of its own:
// every key it holds is one the desktop handed it.
const env = { ...process.env };
for (const name of ["DEUS_CLOUD_URL", "DEUS_CLOUD_ENV", "AGNT_API_KEY", "DEUS_CLOUD_AGNT_API_KEY"])
  delete env[name];
const log = createWriteStream(path.join(directory, "backend.log"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...env,
    PORT: "0",
    DATABASE_PATH: path.join(directory, "deus.db"),
    // Never the login Keychain, and git never climbs out of the run into this checkout.
    DEUS_VAULT_NO_KEYCHAIN: "1",
    GIT_CEILING_DIRECTORIES: directory,
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGNT_BASE_URL: platform.url,
    DEUS_GITHUB_API_URL: `${platform.url}/github`,
    DEUS_BUNDLED_BIN_DIR: path.join(root, "test/e2e/fixtures/github"),
    DEUS_CLOUD_AGNT_URL: platform.url,
    // As the desktop starts it: the spawn token is the first line on its stdin.
    DEUS_STOP_ON_STDIN_END: "1",
  },
});
child.stdin.write("desktop-orgs-token\n");
child.stdout.pipe(log);
child.stderr.pipe(log);
let backend;

try {
  const port = await new Promise((resolve, reject) => {
    let started = "";
    const timeout = setTimeout(() => reject(new Error("backend startup timed out")), 90_000);
    child.once("exit", (code) => reject(new Error(`backend exited ${code}`)));
    child.stdout.on("data", (data) => {
      started += String(data);
      const match = started.match(/^\[BACKEND_PORT\](\d+)$/m);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
  // What the desktop app hands the backend: the account's session and one key per organization.
  const handCredentials = async (orgKeys) => {
    const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: { authorization: "Bearer desktop-orgs-token", "content-type": "application/json" },
      body: JSON.stringify({ deusCloudSessionToken: BEARER, orgKeys }),
    });
    assert.equal(handed.status, 200, await handed.text());
  };
  backend = await connectBackend(`http://127.0.0.1:${port}`);
  const connect = (row) => backend.write("connectCloudWorkspace", { workspaceId: row.id });
  const live = (row) => platform.live(row.provider);
  const metadataFor = (row) => platform.keyed.filter((request) => request.session === row.provider);

  // 1. Only Acme is set up yet: its workspace connects.
  const legacyOrganization = () =>
    db.prepare("SELECT organization_id FROM workspaces WHERE id = ?").get(legacy.id)
      .organization_id;
  await handCredentials({ [ORG_A.id]: ORG_A.key });
  await connect(inA);
  await until("Acme's socket", () => live(inA));
  await until("Acme's metadata", () => metadataFor(inA).length > 0);
  check("a workspace in the first organization connected with that organization's key");

  // 2. Beta's key arrives (provisioning finished for it): nothing already open is touched.
  const socketA = live(inA);
  await handCredentials({ [ORG_A.id]: ORG_A.key, [ORG_B.id]: ORG_B.key });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(socketA.open, true, "the first organization's socket stayed open");
  assert.equal(platform.socketsFor(inA.provider).length, 1, "and was not replaced");
  check("a second organization's key arriving closed nothing and reconnected nothing");

  // 3. Beta's workspace and the one that names no organization connect beside it.
  await connect(inB);
  assert.equal(legacyOrganization(), null, "the credentials stamped the row");
  check("the row that names no organization is not stamped: it is read as the default's");
  await connect(legacy);
  await until("all three sockets at once", () => rows.every((row) => live(row)?.open));
  await until("every session's metadata", () => rows.every((row) => metadataFor(row).length > 0));
  // The legacy row's connect sent its metadata with the default's key (Acme's), which
  // the platform refuses for a Beta session; the snapshot then corrects the row.
  for (const row of rows) {
    const expected = row.org === ORG_B.id ? ORG_B.key : ORG_A.key;
    assert.deepEqual(
      [...new Set(metadataFor(row).map((request) => request.key))],
      [expected],
      `${row.provider}'s metadata carried its organization's key`
    );
  }
  assert.equal(
    platform.requests.filter((route) => route.startsWith("PATCH")).length,
    platform.keyed.length
  );
  check("two organizations' workspaces are connected at once, each request with its own key", {
    sockets: rows.map((row) => `${row.provider}:${live(row).open ? "open" : "closed"}`).join(" "),
    metadata: platform.keyed.map((request) => `${request.session}<-${request.key}`).join(" "),
  });

  // 4. The row that named no organization learned its real one from its snapshot.
  await until("the legacy row's organization", () => legacyOrganization() === ORG_B.id);
  const read = await backend.read("workspace", { workspaceId: legacy.id });
  assert.equal(read.organization_id, ORG_B.id, "clients read a workspace's organization");
  check("a row that named no organization took the one its snapshot names; clients read it");

  // 5. Every client can read the account's organizations, and which are ready here.
  const organizations = await until("the organization list", async () => {
    const value = await backend.read("cloudOrganizations");
    return value.items.length > 0 ? value : null;
  });
  assert.deepEqual(organizations, {
    available: true,
    accountId: "acc_smoke",
    defaultOrganizationId: ORG_A.id,
    items: [
      { id: ORG_A.id, name: ORG_A.name, role: "owner", ready: true },
      { id: ORG_B.id, name: ORG_B.name, role: "owner", ready: true },
    ],
  });
  check("cloudOrganizations lists both organizations, ready, with the default", organizations);

  const unexpected = platform.unserved.filter((route) => !UNSERVED.has(route));
  assert.deepEqual(unexpected, [], "the backend asked the platform only for what it serves");
  console.log(`\nAll checks passed. Artifacts: ${directory}`);
} catch (error) {
  console.error(`FAILED: ${error.stack ?? error}\nArtifacts: ${directory}`);
  process.exitCode = 1;
} finally {
  backend?.close();
  child.kill();
  platform.close();
  db.close();
}
