/* global window */
// Workspace links in the built desktop app, from Electron's entry points to the chat transcript.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { WORKSPACE_LINK_AVAILABLE } from "../../shared/events.ts";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { workspaceLink } from "../../shared/workspace-link.ts";
import { launchInBackground, watchForeground } from "./lib/launch-in-background.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, ".context/workspace-links-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const data = path.join(directory, "data");
const project = path.join(directory, "project");
const tmp = path.join(directory, "tmp");
await Promise.all([data, project, tmp].map((folder) => mkdir(folder)));
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
git("init", "-b", "main");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.test",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--allow-empty",
  "-m",
  "Fixture"
);

const dbPath = path.join(data, "deus.db");
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
const repo = crypto.randomUUID();
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Desktop links', ?)").run(
  repo,
  project
);

function seedWorkspace(slug, texts) {
  const workspaceId = crypto.randomUUID();
  const chats = texts.map((text) => ({ text, id: crypto.randomUUID() }));
  git("worktree", "add", "-b", slug, path.join(project, ".deus", slug));
  db.prepare(
    `INSERT INTO workspaces (id, repository_id, slug, git_branch, git_target_branch,
    state, setup_status, current_session_id, first_session_id) VALUES (?, ?, ?, ?, 'main',
    'ready', 'completed', ?, ?)`
  ).run(workspaceId, repo, slug, slug, chats[0].id, chats[0].id);
  for (const { id, text } of chats) {
    const message = crypto.randomUUID();
    const part = crypto.randomUUID();
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, agent_harness) VALUES (?, ?, 'claude-code')"
    ).run(id, workspaceId);
    db.prepare("INSERT INTO messages (id, session_id, role) VALUES (?, ?, 'user')").run(
      message,
      id
    );
    db.prepare(
      "INSERT INTO parts (id, message_id, session_id, type, data) VALUES (?, ?, ?, 'text', ?)"
    ).run(part, message, id, JSON.stringify({ id: part, type: "text", state: "done", text }));
  }
  return { chats, link: (chat) => workspaceLink({ workspaceId, sessionId: chat?.id }) };
}

const release = seedWorkspace("release", ["The checklist is ready.", "The build is signed."]);
const handoff = seedWorkspace("handoff", ["Please review the handoff notes."]);
const [checklist, signed] = release.chats;
const [notes] = handoff.chats;
db.close();
await writeFile(
  path.join(data, "preferences.json"),
  JSON.stringify({ onboarding_completed: true, remote_access_enabled: false })
);

const guard = watchForeground();
const desktop = await launchInBackground({
  args: [root, `--user-data-dir=${data}`, release.link(signed)],
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: "",
    DEUS_USER_DATA_DIR: data,
    DATABASE_PATH: dbPath,
    DEUS_VAULT_NO_KEYCHAIN: "1",
    AGENT_ALLOW_AGENTLESS: "1",
    GIT_CEILING_DIRECTORIES: directory,
    GH_CONFIG_DIR: path.join(directory, "gh"),
    DEUS_CLOUD_URL: "http://127.0.0.1:9",
    AGNT_BASE_URL: "http://127.0.0.1:9",
    TMPDIR: tmp,
  },
});
const pid = desktop.process().pid;
console.log(`Electron PID ${pid}, fixture ${directory}`);

try {
  const page = await desktop.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(15_000);
  const text = (words) => page.getByText(words, { exact: true });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const shown = (chat) => text(chat.text).waitFor();
  const openUrl = (...urls) =>
    desktop.evaluate(({ app }, urls) => {
      for (const url of urls) app.emit("open-url", { preventDefault() {} }, url);
    }, urls);
  const settings = async () => {
    await page.getByRole("button", { name: /switch where workspaces run/i }).click();
    await page.getByRole("menuitem", { name: /^Settings/ }).click();
    await button("Back to app").waitFor();
  };

  await shown(signed);
  const native = await desktop.evaluate(({ app, BrowserWindow }) => ({
    data: app.getPath("userData"),
    lock: app.hasSingleInstanceLock(),
    visible: BrowserWindow.getAllWindows()[0].isVisible(),
    opacity: BrowserWindow.getAllWindows()[0].getOpacity(),
  }));
  assert.equal(native.data, data);
  assert(native.lock && native.visible);
  if (process.platform === "darwin") assert.equal(native.opacity, 0);
  console.log("PASS launch argv opened the named chat");

  await openUrl(handoff.link(notes));
  await shown(notes);
  await openUrl(release.link());
  await shown(signed);
  console.log(
    "PASS a running link switched workspaces and a workspace link restored its active chat"
  );

  await desktop.evaluate(
    ({ app }, url) => app.emit("second-instance", {}, [process.execPath, url], process.cwd(), {}),
    release.link(checklist)
  );
  await shown(checklist);
  console.log("PASS second-instance argv switched chats");

  await text("Automations").click();
  await text("Automations run in Deus Cloud").waitFor();
  await openUrl(handoff.link(notes));
  await shown(notes);
  await settings();
  await openUrl(release.link(signed));
  await shown(signed);
  console.log("PASS links opened their chats from Automations and Settings");

  const wakes = await page.evaluateHandle((channel) => {
    const observed = [];
    window.electronAPI.on(channel, () => observed.push(channel));
    return observed;
  }, WORKSPACE_LINK_AVAILABLE);
  await openUrl(handoff.link(notes) + "&extra=1");
  await shown(signed);
  // The following valid wake is on the same IPC channel and must arrive after any refused one.
  await openUrl(workspaceLink({ workspaceId: crypto.randomUUID() }));
  await text("No open workspace matches that link on this computer.").waitFor();
  await shown(signed);
  assert.equal(await wakes.evaluate((seen) => seen.length), 1);
  console.log(
    "PASS a refused address left the chat in place with zero wakes, and an unknown workspace explained why"
  );

  await openUrl(handoff.link(signed));
  await text("That chat is no longer open in this workspace.").waitFor();
  await shown(notes);
  console.log("PASS a chat from another workspace opened the workspace and explained why");

  await openUrl(release.link(checklist), release.link(signed));
  await shown(signed);
  console.log("PASS back-to-back links ended on the second chat");

  await settings();
  await button("General").click();
  await button("Replay").click();
  await button("Run Deus").waitFor();
  await openUrl(handoff.link(notes));
  assert(await button("Run Deus").isVisible());
  assert(!(await text(notes.text).isVisible()));
  await button("Run Deus").click();
  for (const [heading, action] of [
    ["Sign in to Deus Cloud", "Skip"],
    ["Connect GitHub", "Skip"],
    ["Connect your AI tools", "Continue"],
    ["Your Projects", "Continue"],
    ["Shape Deus with us", "Skip"],
  ]) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await button(action).click();
  }
  await shown(notes);
  console.log("PASS a link waited through onboarding and opened its chat on completion");
} finally {
  try {
    await desktop.close();
  } finally {
    await guard.assertNeverFrontmost(pid);
  }
}
