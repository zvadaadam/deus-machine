// Real settings components → desktop proxy / direct product API → encrypted Postgres store.
// Requires the linked AGNT workspace and a migrated SECRET_TEST_DATABASE_URL (see README).
/* global Bun, window, document, DataTransfer */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const agnt = process.env.AGNT_WORKSPACE;
assert(agnt, "Set AGNT_WORKSPACE to the linked AGNT worktree");
assert(
  process.env.SECRET_TEST_DATABASE_URL,
  "Set SECRET_TEST_DATABASE_URL to a migrated test database"
);
const directory = path.join(root, ".context/environment-secrets-ui");
await mkdir(directory, { recursive: true });
const fixtureFile = path.join(directory, "fixture.json");
const selectedModel = "codex-app-server:gpt-6-astra";
const providerAccounts = {
  providers: [],
  default_account_ids: { codex: "codex-fixture" },
  accounts: [
    {
      id: "codex-fixture",
      provider: "codex",
      auth_method: "subscription",
      label: "Test account",
      email: null,
      plan_type: null,
      status: "connected",
      is_default: true,
    },
  ],
};
const script = `
  import { createSecretFixture } from ${JSON.stringify(path.join(agnt, "apps/backend/tests/integration/secret-fixture.ts"))};
  const fixture = await createSecretFixture();
  // External GitHub discovery is synthetic; settings and secret writes use real auth + Postgres.
  fixture.app.get("/orgs/:org/github/:action", c => {
    if (c.req.param("action") === "environment") return c.json({ project: null, branch: "main" });
    if (!Object.values(fixture.tokens).some(token => c.req.header("authorization") === "Bearer " + token)) return c.json({}, 401);
    return c.json(c.req.param("action") === "install-url"
      ? { url: "https://github.com/apps/deus-bot/installations/new" }
      : { repos: c.req.param("org") === fixture.ids.org ? ["acme/mobile-app", "acme/new-app", "acme/web-app", "acme/desktop-recipe", "acme/web-recipe"] : [] });
  });
  fixture.app.get("/me/provider-accounts", c => c.json(${JSON.stringify(providerAccounts)}));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => fixture.app.fetch(req, fixture.env) });
  await Bun.write(${JSON.stringify(fixtureFile)}, JSON.stringify({ baseUrl: server.url.origin, ids: fixture.ids, tokens: fixture.tokens }), { mode: 0o600 });
  console.log("FIXTURE_READY");
  process.on("SIGTERM", async () => { server.stop(true); await fixture.close(); process.exit(0); });
`;
const processFixture = Bun.spawn(["bun", "-e", script], {
  cwd: agnt,
  stdout: "pipe",
  stderr: "inherit",
});
let browser;
let vite;
let proxy;
let activePage;
try {
  const reader = processFixture.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("FIXTURE_READY")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  assert(output.includes("FIXTURE_READY"), "Fixture startup failed");
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  // The actual desktop forwarding routes, in an isolated in-memory Hono host.
  const { Hono } = await import("hono");
  const { cors } = await import("hono/cors");
  const { default: routes } = await import("../../apps/backend/src/routes/environment-secrets.ts");
  const { setCloudRuntimeCredentials, resetCloudConfigForTests } =
    await import("../../apps/backend/src/services/agent/cloud/config.ts");
  const { readProjectFile, writeProjectFile } =
    await import("../../apps/backend/src/services/project-environment.service.ts");
  const localDirectory = path.join(directory, "repository");
  await rm(localDirectory, { recursive: true, force: true });
  await mkdir(localDirectory, { recursive: true });
  const app = new Hono().use("*", cors()).route("/api", routes);
  app.get("/api/test-environment-file", (c) =>
    c.json({ project: readProjectFile(localDirectory), branch: "test-branch" })
  );
  app.post("/api/test-environment-file", async (c) => {
    writeProjectFile(localDirectory, await c.req.json());
    return c.json({ ok: true });
  });
  app.get("/api/settings/provider-accounts", (c) => c.json(providerAccounts));
  setCloudRuntimeCredentials({
    baseUrl: fixture.baseUrl,
    deusCloudUrl: fixture.baseUrl,
    orgId: fixture.ids.org,
    deusCloudSessionToken: fixture.tokens.alice,
  });
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) });
  const entry = path.join(directory, "entry.tsx");
  await writeFile(
    entry,
    `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClientProvider } from "@tanstack/react-query";
    import { queryClient } from "@/shared/api/queryClient";
    import { TooltipProvider } from "@/components/ui/tooltip";
    import { useUIStore } from "@/shared/stores/uiStore";
    import { EnvironmentSection } from "@/features/settings/ui/sections/EnvironmentSection";
    import "@/global.css";
    const repository = new URL(window.location.href).searchParams.get("repo");
    if (repository) useUIStore.getState().openEnvironmentSettings(repository, "cloud");
    window.secretTestSetupRequest = () => useUIStore.getState().pendingEnvSetup;
    window.secretTestClearSetupRequest = () => useUIStore.getState().clearEnvSetupRequest();
    window.secretCacheContains = value => JSON.stringify([queryClient.getQueryCache().getAll().map(q => q.state.data), queryClient.getMutationCache().getAll().map(m => m.state)]).includes(value);
    createRoot(document.getElementById("root")).render(<React.StrictMode><QueryClientProvider client={queryClient}><TooltipProvider><main className="mx-auto h-screen max-w-4xl overflow-y-auto p-4 sm:p-8"><EnvironmentSection /></main></TooltipProvider></QueryClientProvider></React.StrictMode>);
  `
  );
  browser = await chromium.launch({ headless: true });
  for (const direct of [false, true]) {
    vite = await createServer({
      configFile: false,
      root,
      logLevel: "error",
      esbuild: { jsx: "automatic" },
      optimizeDeps: { entries: [entry] },
      define: {
        "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify(direct ? "1" : "0"),
        "import.meta.env.VITE_AGNT_BASE_URL": JSON.stringify(fixture.baseUrl),
        "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify(fixture.baseUrl),
        "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(proxy.port)),
      },
      resolve: {
        alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
      },
      plugins: [
        tailwindcss(),
        {
          name: "secret-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id.endsWith("platform/native/deus-cloud")) return "\0native-secret-fixture";
            if (id.endsWith("repository.service")) return "\0repository-fixture";
          },
          load(id) {
            if (id === "\0repository-fixture")
              return `
              const repos = [
                { id: "local", name: "mobile-app", root_path: "/projects/mobile-app", git_origin_url: "git@github.com:acme/mobile-app.git", git_default_branch: "main" },
                { id: "local-only", name: "local-only", root_path: "/projects/local-only", git_origin_url: null, git_default_branch: "main" },
                { id: "public", name: "public-app", root_path: "/projects/public-app", git_origin_url: "https://github.com/octocat/Hello-World", git_default_branch: "main" }
              ];
              export const RepoService = {
                fetchAll: async () => repos,
                fetchEnvironmentFile: async () => { const r = await fetch(${JSON.stringify(`${proxy.url.origin}/api/test-environment-file`)}); if (!r.ok) throw new Error("Invalid repository environment"); return r.json(); },
                saveEnvironmentFile: async (_id, project) => { const r = await fetch(${JSON.stringify(`${proxy.url.origin}/api/test-environment-file`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(project) }); if (!r.ok) throw new Error("Couldn't save environment"); }
              };`;
            if (id !== "\0native-secret-fixture") return;
            return `export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/native/deus-cloud.ts"))};
            let session = { signedIn: true, accountId: ${JSON.stringify(fixture.ids.alice)}, hasPlatformKey: true };
            const listeners = new Set();
            export const getSession = async () => session;
            export const onAuthChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
            window.secretTestSignIn = accountId => { session = { ...session, accountId }; for (const fn of listeners) fn(session); };`;
          },
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url?.split("?")[0] !== "/") return next();
              res.setHeader("content-type", "text/html");
              res.end(
                '<!doctype html><html class="dark"><body><div id="root"></div><script type="module" src="/.context/environment-secrets-ui/entry.tsx"></script></body></html>'
              );
            });
          },
        },
      ],
      // Fixture file writes must not reload the page during a settings journey.
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    });
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    activePage = page;
    await page.addInitScript(
      ({ token, model }) => {
        sessionStorage.setItem("deus_cloud_session", token);
        localStorage.setItem("deus:welcome-last-model", model);
      },
      { token: fixture.tokens.alice, model: selectedModel }
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    const shot = (name) =>
      page.screenshot({
        path: path.join(directory, `${direct ? "web" : "desktop"}-${name}.png`),
        fullPage: true,
        animations: "disabled",
      });
    const chooseOrg = async (name) => {
      await page.getByLabel("Organization", { exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const openRepository = () => page.getByRole("button", { name: /acme\/mobile-app/ }).click();
    const setupScript = `bun install --frozen-lockfile\nbun run prepare\n# ${direct ? "web" : "desktop"}`;
    await page.goto(vite.resolvedUrls.local[0]);
    await chooseOrg("Secret test organization");
    await page.getByText("Setup saved", { exact: true }).first().waitFor();
    await shot("repositories");
    // First save creates the environment; a second save edits that same environment.
    // Keep the draft visible while the repository list picks up the new ID.
    const newRepo = `acme/${direct ? "web-recipe" : "desktop-recipe"}`;
    await page.getByRole("button", { name: new RegExp(newRepo) }).click();
    await page.getByLabel("Setup script", { exact: true }).fill("./scripts/bootstrap.sh");
    await page.getByRole("button", { name: "Save setup", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Setup script", { exact: true }).inputValue(),
      "./scripts/bootstrap.sh"
    );
    await page.getByLabel("Run script", { exact: true }).fill("./scripts/start.sh");
    await page.getByRole("button", { name: "Save setup", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(newRepo) }).click();
    assert.equal(
      await page.getByLabel("Run script", { exact: true }).inputValue(),
      "./scripts/start.sh"
    );
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await openRepository();
    const repositoryLink = page.getByRole("link", {
      name: "https://github.com/acme/mobile-app",
      exact: true,
    });
    assert.equal(await repositoryLink.getAttribute("href"), "https://github.com/acme/mobile-app");
    assert.equal(await repositoryLink.getAttribute("target"), "_blank");
    assert.equal(
      await page
        .getByRole("tablist", { name: "Setup workspace location" })
        .getAttribute("aria-orientation"),
      "horizontal"
    );
    const localTab = await page.getByRole("tab", { name: "Local", exact: true }).boundingBox();
    const cloudTab = await page.getByRole("tab", { name: "Cloud", exact: true }).boundingBox();
    const linkBox = await repositoryLink.boundingBox();
    assert(localTab && cloudTab && linkBox);
    assert.equal(localTab.y, cloudTab.y);
    assert(localTab.y >= linkBox.y + linkBox.height);
    await shot("repository-header");
    assert.equal(
      await page.getByRole("button", { name: "Set up with agent", exact: true }).count(),
      1
    );
    if (!direct) {
      await page.getByRole("button", { name: "Set up with agent", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.secretTestSetupRequest()), {
        repoId: "local",
        location: "cloud",
        model: selectedModel,
      });
      await page.evaluate(() => window.secretTestClearSetupRequest());
    } else {
      assert.equal(
        await page.getByRole("button", { name: "Set up with agent", exact: true }).isDisabled(),
        true
      );
    }
    await page.getByLabel("Setup script", { exact: true }).fill(setupScript);
    await page.getByLabel("Run script", { exact: true }).fill("bun run dev");
    if (!direct) {
      await page.getByRole("tab", { name: "Cloud", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await page.getByRole("tab", { name: "Local", selected: true }).waitFor();
      assert.equal(
        await page.getByLabel("Setup script", { exact: true }).inputValue(),
        setupScript
      );
      await page.keyboard.press("ArrowRight");
      await page.getByRole("tab", { name: "Cloud", selected: true }).waitFor();
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: "Set up with agent", exact: true }).click();
      assert.equal(await page.evaluate(() => window.secretTestSetupRequest()), null);
      assert.equal(
        await page.getByLabel("Setup script", { exact: true }).inputValue(),
        setupScript
      );
    }
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    assert.equal(await page.getByLabel("Setup script", { exact: true }).inputValue(), setupScript);
    page.once("dialog", (dialog) => dialog.dismiss());
    await chooseOrg("Another organization");
    await page.getByRole("form", { name: "Project environment", exact: true }).waitFor();
    await page.getByRole("button", { name: "Save setup", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    const metadata = await fetch(
      `${fixture.baseUrl}/dashboard/orgs/${fixture.ids.org}/environment-settings?environment_id=${fixture.ids.env}`,
      { headers: { authorization: `Bearer ${fixture.tokens.alice}` } }
    ).then((r) => r.json());
    assert.equal(metadata.selected_environment.project.setup, setupScript);
    assert.equal(
      metadata.environments.find((env) => env.id === fixture.ids.env).is_repository_default,
      true
    );
    await page.getByRole("button", { name: "Set value", exact: true }).click();
    const value = `ui-${direct ? "web" : "desktop"}-${crypto.randomUUID()}`;
    await page.getByLabel("Value", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await page.getByText("All values set", { exact: true }).waitFor();
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    await shot("cloud-setup");
    if (!direct) {
      await page.getByRole("tab", { name: "Local", exact: true }).click();
      await page.getByRole("button", { name: "Set up with agent", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.secretTestSetupRequest()), {
        repoId: "local",
        location: "local",
        model: selectedModel,
      });
      await page.evaluate(() => window.secretTestClearSetupRequest());
      // One shared recipe, with only the cloud command changed. File publication is explicit.
      await page.getByText("Customize for local or cloud", { exact: true }).click();
      await page.getByLabel("cloud run behavior").selectOption("custom");
      await page.getByLabel("cloud run script").fill("bun run dev --host 0.0.0.0");
      await page.getByLabel("Variable 1 name").fill("PUBLIC_MODE");
      await page.getByLabel("Variable 1 value").fill("development");
      await page.getByRole("button", { name: "Save to repository", exact: true }).click();
      await page.getByText(/Local checkout; publish changes through Git/).waitFor();
      const project = readProjectFile(localDirectory);
      assert.equal(project.setup, setupScript);
      assert.equal(project.cloud.run, "bun run dev --host 0.0.0.0");
      assert.equal(project.env.PUBLIC_MODE, "development");
      assert(!JSON.stringify(project).includes(value));
      await page.getByLabel("Setup script", { exact: true }).fill("./scripts/setup.sh");
      await page.getByRole("button", { name: "Save setup", exact: true }).click();
      await page.getByText("Saved", { exact: true }).waitFor();
      assert.equal(readProjectFile(localDirectory).setup, "./scripts/setup.sh");
      const unchanged = await fetch(
        `${fixture.baseUrl}/dashboard/orgs/${fixture.ids.org}/environment-settings?environment_id=${fixture.ids.env}`,
        { headers: { authorization: `Bearer ${fixture.tokens.alice}` } }
      ).then((r) => r.json());
      assert.equal(unchanged.selected_environment.project.setup, setupScript);
      await shot("repository-file");
      // A broken file surfaces an error; deleting it returns to saved settings.
      await writeFile(path.join(localDirectory, ".deus/environment.json"), "{broken");
      await page.reload();
      await chooseOrg("Secret test organization");
      await openRepository();
      await page.getByText("Invalid repository environment", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Save setup", exact: true }).count(), 0);
      await rm(path.join(localDirectory, ".deus/environment.json"));
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      assert.equal(
        await page.getByLabel("Setup script", { exact: true }).inputValue(),
        setupScript
      );
    }
    await chooseOrg("Another organization");
    await page.getByRole("button", { name: "Default secrets", exact: true }).click();
    await page.getByText("No secrets added yet.", { exact: true }).waitFor();
    await chooseOrg("Secret test organization");
    await openRepository();
    await page.getByText("All values set", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await page.getByLabel("New value", { exact: true }).fill("unsaved-value");
    for (const actor of ["bob", "alice"]) {
      let releaseOrganizations;
      const organizationsUrl = "**/settings/environment-secrets/orgs";
      const heldRequests = [];
      const holdOrganizations = (route) => {
        const handled = organizationsGate.then(() => route.continue());
        heldRequests.push(handled);
        return handled;
      };
      let organizationsGate;
      let requestStarted;
      if (!direct && actor === "bob") {
        organizationsGate = new Promise((resolve) => {
          releaseOrganizations = resolve;
        });
        requestStarted = page.waitForRequest(organizationsUrl);
        await page.route(organizationsUrl, holdOrganizations);
      }
      setCloudRuntimeCredentials({ deusCloudSessionToken: fixture.tokens[actor] });
      await page.evaluate(
        ({ token, id }) => {
          sessionStorage.setItem("deus_cloud_session", token);
          window.secretTestSignIn(id);
        },
        { token: fixture.tokens[actor], id: fixture.ids[actor] }
      );
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (requestStarted) {
        try {
          await requestStarted;
          assert.equal(
            await page.getByRole("button", { name: /local-only/ }).count(),
            0,
            "Repository editing must wait for the new account's organization context"
          );
        } finally {
          releaseOrganizations();
          await Promise.all(heldRequests);
          await page.unroute(organizationsUrl, holdOrganizations);
        }
      }
      if (actor === "alice") await chooseOrg("Secret test organization");
      if (!direct && actor === "bob") {
        // Organization roles must not restrict edits to a local-only repository file.
        await page.getByRole("button", { name: /local-only/ }).click();
        await page.getByText(/Local repository file/).waitFor();
        assert.equal(await page.getByLabel("Setup script", { exact: true }).isEditable(), true);
        assert.equal(await page.getByRole("button", { name: "Save to repository" }).count(), 0);
        await page.getByRole("button", { name: "Repositories", exact: true }).click();
      }
      await openRepository();
      await page
        .getByText(actor === "bob" ? "1 missing" : "All values set", { exact: true })
        .waitFor();
      if (actor === "bob")
        assert.equal(await page.getByRole("button", { name: "Replace", exact: true }).count(), 0);
    }
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    assert.equal(await page.getByLabel("New value", { exact: true }).inputValue(), "");
    await page.getByLabel("New value", { exact: true }).fill(`${value}-replacement`);
    await page.getByRole("button", { name: "Replace value", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete secret", exact: true }).click();
    await page.getByText("1 missing", { exact: true }).waitFor();
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    await page
      .getByRole("button", { name: "Manage secrets for all repositories", exact: true })
      .click();
    await page.getByRole("button", { name: "Add secret", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("ELEVENLABS_API_KEY");
    await page.getByLabel("Value", { exact: true }).fill(`${value}-default`);
    await page.getByLabel("Available to", { exact: true }).click();
    await page.getByRole("option", { name: "Everyone in the organization", exact: true }).click();
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByText("ELEVENLABS_API_KEY", { exact: true }).waitFor();
    await shot("defaults");
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await openRepository();
    await page.getByText("Shared · All repositories", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Replace", exact: true }).count(), 0);
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("mobile-detail");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp(direct ? "acme/web-app" : "acme/new-app") })
      .click();
    await page.getByLabel("Setup script", { exact: true }).fill("bun install");
    await page.getByLabel("Run script", { exact: true }).fill("bun run dev --host 0.0.0.0");
    // Import before saving scripts: creating the environment must preserve both drafts.
    assert.equal(await page.getByRole("button", { name: "Replace", exact: true }).count(), 0);
    const envFile = `E2B_API_KEY="${value}"\nAPP_MODE=preview\nOPTIONAL=\n`;
    if (direct) {
      const dataTransfer = await page.evaluateHandle((text) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], ".env", { type: "text/plain" }));
        return transfer;
      }, envFile);
      await page
        .getByRole("button", {
          name: "Drop a .env or .dev.vars file, or click to import",
          exact: true,
        })
        .dispatchEvent("drop", { dataTransfer });
      await dataTransfer.dispose();
    } else {
      await page.getByLabel("Import environment file", { exact: true }).setInputFiles({
        name: ".dev.vars",
        mimeType: "text/plain",
        buffer: Buffer.from(envFile),
      });
    }
    await page.getByRole("dialog").waitFor();
    await page.getByText("Empty · skipped", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("dialog")
        .textContent()
        .then((text) => text.includes(value)),
      false
    );
    await shot("import-review");
    await page.getByRole("button", { name: "Import 2 secrets", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByText("E2B_API_KEY", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Setup script", { exact: true }).inputValue(),
      "bun install"
    );
    assert.equal(
      await page.getByLabel("Run script", { exact: true }).inputValue(),
      "bun run dev --host 0.0.0.0"
    );
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    await page.getByRole("button", { name: "Save setup", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    if (direct) {
      const settings = await fetch(
        `${fixture.baseUrl}/dashboard/orgs/${fixture.ids.org}/environment-settings`,
        { headers: { authorization: `Bearer ${fixture.tokens.alice}` } }
      ).then((response) => response.json());
      const importedEnv = settings.environments.find(
        (environment) => environment.repo === "https://github.com/acme/web-app"
      );
      assert(importedEnv);
      const sharedScope = await fetch(
        `${fixture.baseUrl}/dashboard/orgs/${fixture.ids.org}/environment-settings/secrets/MULTI_SCOPE_KEY`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${fixture.tokens.alice}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            owner_type: "USER",
            environment_ids: [importedEnv.id, fixture.ids.env],
            value: "unchanged-synthetic-value",
          }),
        }
      );
      assert.equal(sharedScope.status, 200);
    }
    await page.reload();
    await chooseOrg("Secret test organization");
    await page
      .getByRole("button", { name: new RegExp(direct ? "acme/web-app" : "acme/new-app") })
      .click();
    assert.equal(
      await page.getByLabel("Run script", { exact: true }).inputValue(),
      "bun run dev --host 0.0.0.0"
    );
    if (direct) {
      await page.getByLabel("Import environment file", { exact: true }).setInputFiles({
        name: ".env",
        mimeType: "text/plain",
        buffer: Buffer.from("MULTI_SCOPE_KEY=must-not-send\nNEW_IMPORT_KEY=synthetic-value"),
      });
      const conflict = page.getByRole("dialog").getByRole("checkbox", { name: /MULTI_SCOPE_KEY/ });
      assert.equal(await conflict.isDisabled(), true);
      assert.equal(await conflict.isChecked(), false);
      await shot("import-scope-conflict");
      const request = page.waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith("/secrets/import")
      );
      await page.getByRole("button", { name: "Import 1 secret", exact: true }).click();
      assert.deepEqual(
        (await request).postDataJSON().secrets.map((secret) => secret.name),
        ["NEW_IMPORT_KEY"]
      );
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("NEW_IMPORT_KEY", { exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await shot("mobile-list");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    if (!direct) {
      await page.getByRole("button", { name: /octocat\/Hello-World/ }).click();
      await page.getByText(/Saved project settings/).waitFor();
      assert.equal(await page.getByLabel("Setup script", { exact: true }).isEditable(), true);
      await page.locator('[data-slot="avatar-image"]').waitFor();
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
    }
    // Clean the shared default before repeating the journey through the other transport.
    await page.getByRole("button", { name: "Default secrets", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete secret", exact: true }).click();
    await page.getByText("No secrets added yet.", { exact: true }).waitFor();

    // One name at all four precedence levels. Check both transports and both accounts.
    const scopeName = "APP_KEY";
    const secretRow = (label) =>
      page
        .getByText(scopeName, { exact: true })
        .locator("..")
        .filter({ hasText: label })
        .locator("..");
    const addScopedValue = async (shared) => {
      await page.getByRole("button", { name: "Add secret", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill(scopeName);
      await page
        .getByLabel("Value", { exact: true })
        .fill(`${value}-${shared ? "shared" : "personal"}`);
      if (shared) {
        await page.getByLabel("Available to", { exact: true }).click();
        await page
          .getByRole("option", { name: "Everyone in the organization", exact: true })
          .click();
      }
      await page.getByRole("button", { name: "Save secret", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    };
    await addScopedValue(true);
    await addScopedValue(false);
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await openRepository();
    await addScopedValue(true);
    await addScopedValue(false);
    for (const label of [
      "Shared · All repositories",
      "Personal · All repositories",
      "Shared · This repository",
      "Personal · This repository",
    ])
      await secretRow(label).waitFor();
    await shot("secret-precedence");
    for (const actor of ["bob", "alice"]) {
      setCloudRuntimeCredentials({ deusCloudSessionToken: fixture.tokens[actor] });
      await page.evaluate(
        ({ token, id }) => {
          sessionStorage.setItem("deus_cloud_session", token);
          window.secretTestSignIn(id);
        },
        { token: fixture.tokens[actor], id: fixture.ids[actor] }
      );
      if (actor === "alice") await chooseOrg("Secret test organization");
      await openRepository();
      await page.getByText("All values set", { exact: true }).waitFor();
      await secretRow("Shared · This repository").waitFor();
      assert.equal(
        await secretRow("Personal · This repository").count(),
        actor === "alice" ? 1 : 0
      );
      assert.equal(
        await secretRow("Personal · All repositories").count(),
        actor === "alice" ? 1 : 0
      );
      if (actor === "bob") {
        assert.equal(
          await secretRow("Shared · This repository")
            .getByRole("button", { name: "Delete", exact: true })
            .count(),
          0
        );
        await page.getByRole("button", { name: "Repositories", exact: true }).click();
        await page
          .getByRole("button", { name: new RegExp(direct ? "acme/web-app" : "acme/new-app") })
          .click();
        await secretRow("Shared · All repositories").waitFor();
        assert.equal(await secretRow("Shared · This repository").count(), 0);
        assert.equal(await secretRow("Personal · All repositories").count(), 0);
      }
    }
    for (const label of ["Personal · This repository", "Shared · This repository"]) {
      await secretRow(label).getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete secret", exact: true }).click();
      await secretRow(label).waitFor({ state: "hidden" });
      await page.getByText("All values set", { exact: true }).waitFor();
    }
    await page
      .getByRole("button", { name: "Manage secrets for all repositories", exact: true })
      .click();
    for (const label of ["Personal · All repositories", "Shared · All repositories"]) {
      await secretRow(label).getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete secret", exact: true }).click();
      await secretRow(label).waitFor({ state: "hidden" });
    }
    await page.getByText("No secrets added yet.", { exact: true }).waitFor();
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    if (!direct) {
      // A missing settings endpoint must not turn a signed-in account into a login prompt.
      const orgsUrl = /\/api\/settings\/environment-secrets\/orgs$/;
      await page.route(orgsUrl, (route) =>
        route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" })
      );
      await page.reload();
      await page.getByText("Couldn't load cloud environment settings.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /octocat\/Hello-World/ }).click();
      await page.getByText(/Sign in to manage cloud secrets/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Sign in to Deus Cloud" }).count(), 0);
      await shot("organization-unavailable");
      await page.unroute(orgsUrl);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("button", { name: "Default secrets", exact: true }).waitFor();
      assert.equal(await page.getByText("Couldn't load cloud environment settings.").count(), 0);
    }
    // Workspace shortcuts accept local repository IDs and cloud Git remote identities.
    const targetRepository = direct ? "https://github.com/Acme/mobile-app.git" : "local";
    await page.goto(`${vite.resolvedUrls.local[0]}?repo=${encodeURIComponent(targetRepository)}`);
    await chooseOrg("Secret test organization");
    await page.getByRole("form", { name: "Project environment", exact: true }).waitFor();
    assert.match(
      await page.getByRole("navigation", { name: "Environment breadcrumb" }).innerText(),
      /acme\/mobile-app/
    );
    await page.getByRole("tab", { name: "Cloud", selected: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    await vite.close();
    vite = null;
    console.log(
      `${direct ? "Direct web" : "Desktop proxy"}: repository setup → scoped/default secrets → org/account isolation → replace/delete; agent setup targeting, dirty-navigation guards, mobile layout and no values in caches`
    );
  }
  resetCloudConfigForTests();
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(directory, "failure.png"), fullPage: true });
    console.error(await activePage.locator("main").innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  proxy?.stop(true);
  processFixture.kill("SIGTERM");
  await processFixture.exited;
  await writeFile(fixtureFile, JSON.stringify({ retired: true }));
}
