// Full local app: settings UI → backend file write → Git worktree → Setup → Run terminal.
// Start dev:web with a disposable DATABASE_PATH and DEUS_AAP_PID_JOURNAL; set these URLs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const backend = process.env.DEUS_TEST_BACKEND_URL;
const web = process.env.DEUS_TEST_WEB_URL;
assert(
  backend && web,
  "Set DEUS_TEST_BACKEND_URL and DEUS_TEST_WEB_URL for an isolated dev:web runtime"
);
const output = path.resolve(import.meta.dirname, "../../.context/project-environment-app");
await mkdir(output, { recursive: true });
const repo = await mkdtemp(path.join(output, "recipe-app-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "Environment Test");
git("config", "user.email", "test@example.test");
await writeFile(path.join(repo, "README.md"), "Disposable environment qualification\n");
await writeFile(path.join(repo, ".gitignore"), ".env*\n.deus/\n");
await writeFile(path.join(repo, ".env"), "APP_TEST_KEY=local-synthetic-value\n");
// Settings must also work before a new repository has its first commit.
assert.throws(() => git("rev-parse", "--verify", "HEAD"));
const request = async (route, body) => {
  const response = await fetch(
    `${backend}/api${route}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined
  );
  assert(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
};
const registered = await request("/repos", { root_path: repo });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20_000);
try {
  await page.goto(`${web}/s/local/settings`);
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(path.basename(repo)) }).click();
  await page
    .getByLabel("Setup script", { exact: true })
    .fill('printf "%s" "$APP_TEST_KEY" > setup-proof.txt\nprintf "Setup complete\\n"');
  await page
    .getByLabel("Run script", { exact: true })
    .fill('printf "%s" "$APP_TEST_KEY" > run-proof.txt');
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await page.getByText(/Local checkout; publish changes through Git/).waitFor();
  const project = JSON.parse(await readFile(path.join(repo, ".deus/environment.json"), "utf8"));
  assert.equal(project.version, 1);
  assert(!JSON.stringify(project).includes("local-synthetic-value"));
  git("add", ".");
  git("commit", "-qm", "Project environment from Settings");
  await page.screenshot({ path: path.join(output, "settings.png"), fullPage: true });
  const workspace = await request("/workspaces", {
    repository_id: registered.id,
    location: "local",
  });
  const checkout = path.join(repo, ".deus", workspace.slug);
  // Preparation is asynchronous; wait for the persisted status rather than a fixed delay.
  let prepared;
  for (let attempt = 0; attempt < 120; attempt++) {
    prepared = await request(`/workspaces/${workspace.id}`);
    if (prepared.setup_status === "failed") throw new Error(prepared.error_message);
    if (prepared.setup_status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(prepared.setup_status, "completed");
  assert.equal(
    await readFile(path.join(checkout, "setup-proof.txt"), "utf8"),
    "local-synthetic-value"
  );
  assert((await request(`/workspaces/${workspace.id}/setup-logs`)).logs.includes("Setup complete"));
  await page.goto(`${web}/s/local/w/${workspace.id}`);
  await page.getByRole("button", { name: "Run task: run", exact: true }).click();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (
      (await readFile(path.join(checkout, "run-proof.txt"), "utf8").catch(() => null)) ===
      "local-synthetic-value"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    await readFile(path.join(checkout, "run-proof.txt"), "utf8"),
    "local-synthetic-value"
  );
  await page.screenshot({ path: path.join(output, "workspace-run.png"), fullPage: true });
  console.log(
    "PASS: full local app Settings → public recipe saved through backend → Git checkout → copied local dotenv → Setup log → Run button → real terminal process"
  );
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
