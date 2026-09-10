// Real settings components → desktop proxy / direct product API → encrypted Postgres store.
// Requires the linked AGNT workspace and a migrated SECRET_TEST_DATABASE_URL (see README).
/* global Bun, window, document, DataTransfer */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    if (!Object.values(fixture.tokens).some(token => c.req.header("authorization") === "Bearer " + token)) return c.json({}, 401);
    return c.json(c.req.param("action") === "install-url"
      ? { url: "https://github.com/apps/deus-bot/installations/new" }
      : { repos: c.req.param("org") === fixture.ids.org ? ["acme/mobile-app", "acme/new-app", "acme/web-app"] : [] });
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
  const app = new Hono().use("*", cors()).route("/api", routes);
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
    window.secretTestSetupRequest = () => useUIStore.getState().pendingEnvSetup;
    window.secretTestClearSetupRequest = () => useUIStore.getState().clearEnvSetupRequest();
    window.secretCacheContains = value => JSON.stringify([queryClient.getQueryCache().getAll().map(q => q.state.data), queryClient.getMutationCache().getAll().map(m => m.state)]).includes(value);
    createRoot(document.getElementById("root")).render(<React.StrictMode><QueryClientProvider client={queryClient}><TooltipProvider><main className="mx-auto max-w-4xl p-4 sm:p-8"><EnvironmentSection /></main></TooltipProvider></QueryClientProvider></React.StrictMode>);
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
                { id: "public", name: "public-app", root_path: "/projects/public-app", git_origin_url: "https://github.com/octocat/Hello-World", git_default_branch: "main" }
              ];
              let manifest = { version: 1, lifecycle: { setup: "bun install", archive: "./cleanup.sh" }, scripts: { run: "bun run dev" }, env: { PUBLIC_MODE: "development" }, tasks: { test: "bun test" } };
              window.secretTestManifest = () => manifest;
              export const RepoService = {
                fetchAll: async () => repos,
                fetchManifest: async () => ({ manifest: structuredClone(manifest) }),
                saveManifest: async (_id, next) => { manifest = structuredClone(next); }
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
              if (req.url !== "/") return next();
              res.setHeader("content-type", "text/html");
              res.end(
                '<!doctype html><html class="dark"><body><div id="root"></div><script type="module" src="/.context/environment-secrets-ui/entry.tsx"></script></body></html>'
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
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
    await openRepository();
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
    await page.getByLabel("Setup step 1, command 1", { exact: true }).fill(setupScript);
    await page.getByLabel("Run script", { exact: true }).fill("bun run dev");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    assert.equal(
      await page.getByLabel("Setup step 1, command 1", { exact: true }).inputValue(),
      setupScript
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await chooseOrg("Another organization");
    await page.getByRole("form", { name: "Cloud setup", exact: true }).waitFor();
    await page.getByRole("button", { name: "Save cloud setup", exact: true }).click();
    await page.getByRole("button", { name: "Save cloud setup", exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Save cloud setup" && button.disabled
      )
    );
    const metadata = await fetch(
      `${fixture.baseUrl}/dashboard/orgs/${fixture.ids.org}/environment-settings?environment_id=${fixture.ids.env}`,
      { headers: { authorization: `Bearer ${fixture.tokens.alice}` } }
    ).then((r) => r.json());
    assert.deepEqual(metadata.selected_environment.setup, [{ commands: [setupScript] }]);
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
      await page
        .getByLabel("Setup step 1, command 1", { exact: true })
        .fill("unsaved cloud script");
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("tab", { name: "Local", exact: true }).click();
      assert.equal(
        await page.getByLabel("Setup step 1, command 1", { exact: true }).inputValue(),
        "unsaved cloud script"
      );
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("tab", { name: "Local", exact: true }).click();
      await page.getByLabel("Setup script", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Generate", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Auto-detect", exact: true }).count(), 0);
      assert.equal(
        await page.getByText("Public environment variables", { exact: true }).isVisible(),
        true
      );
      assert.equal(await page.getByLabel("Variable 1 value", { exact: true }).isVisible(), true);
      await page.getByRole("button", { name: "Set up with agent", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.secretTestSetupRequest()), {
        repoId: "local",
        location: "local",
        model: selectedModel,
      });
      await page.evaluate(() => window.secretTestClearSetupRequest());
      await page.getByLabel("Setup script", { exact: true }).fill("./scripts/setup.sh");
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: "Set up with agent", exact: true }).click();
      assert.equal(await page.evaluate(() => window.secretTestSetupRequest()), null);
      await page.getByLabel("Run script", { exact: true }).fill("bun run dev --port 3000");
      await page.getByText("Advanced setup", { exact: true }).click();
      assert.equal(
        await page.getByLabel("Archive script", { exact: true }).inputValue(),
        "./cleanup.sh"
      );
      await page.getByRole("button", { name: "Save local setup", exact: true }).click();
      await page.waitForFunction(
        () => window.secretTestManifest().lifecycle.setup === "./scripts/setup.sh"
      );
      assert.equal(
        await page.evaluate(() => window.secretTestManifest().env.PUBLIC_MODE),
        "development"
      );
      await page.getByText("Advanced setup", { exact: true }).click();
      await shot("local-setup");
      await page.getByRole("tab", { name: "Cloud", exact: true }).click();
      assert.equal(
        await page.getByLabel("Setup step 1, command 1", { exact: true }).inputValue(),
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
      setCloudRuntimeCredentials({ deusCloudSessionToken: fixture.tokens[actor] });
      await page.evaluate(
        ({ token, id }) => {
          sessionStorage.setItem("deus_cloud_session", token);
          window.secretTestSignIn(id);
        },
        { token: fixture.tokens[actor], id: fixture.ids[actor] }
      );
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (actor === "alice") await chooseOrg("Secret test organization");
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
    await page.getByRole("button", { name: "Add command", exact: true }).click();
    await page.getByLabel("Setup step 1, command 1", { exact: true }).fill("bun install");
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
      await page.getByLabel("Setup step 1, command 1", { exact: true }).inputValue(),
      "bun install"
    );
    assert.equal(
      await page.getByLabel("Run script", { exact: true }).inputValue(),
      "bun run dev --host 0.0.0.0"
    );
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    await page.getByRole("button", { name: "Save cloud setup", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Save cloud setup" && button.disabled
      )
    );
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
      await page
        .getByLabel("Import environment file", { exact: true })
        .setInputFiles({
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
      await page.getByRole("tab", { name: "Cloud", exact: true }).click();
      await page.getByText(/Connect the Deus GitHub App for private repository access/).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Save cloud setup", exact: true }).isEnabled(),
        true
      );
      await page.locator('[data-slot="avatar-image"]').waitFor();
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
    }
    // Clean the shared default before repeating the journey through the other transport.
    await page.getByRole("button", { name: "Default secrets", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete secret", exact: true }).click();
    await page.getByText("No secrets added yet.", { exact: true }).waitFor();
    if (!direct) {
      // A missing settings endpoint must not turn a signed-in account into a login prompt.
      const orgsUrl = /\/api\/settings\/environment-secrets\/orgs$/;
      await page.route(orgsUrl, (route) =>
        route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" })
      );
      await page.reload();
      await page.getByText("Couldn't load cloud environment settings.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /octocat\/Hello-World/ }).click();
      await page.getByRole("tab", { name: "Cloud", exact: true }).click();
      await page.getByText("Cloud settings are unavailable right now.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Sign in to Deus Cloud" }).count(), 0);
      await shot("organization-unavailable");
      await page.unroute(orgsUrl);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("button", { name: "Default secrets", exact: true }).waitFor();
      assert.equal(await page.getByText("Couldn't load cloud environment settings.").count(), 0);
    }
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
