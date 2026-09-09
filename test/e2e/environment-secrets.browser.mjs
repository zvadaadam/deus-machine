// Real settings components → desktop proxy / direct product API → encrypted Postgres store.
// Requires the linked AGNT workspace and a migrated SECRET_TEST_DATABASE_URL (see README).
/* global Bun, window */
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
const script = `
  import { createSecretFixture } from ${JSON.stringify(path.join(agnt, "apps/backend/tests/integration/secret-fixture.ts"))};
  const fixture = await createSecretFixture();
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
try {
  const reader = processFixture.stdout.getReader();
  const first = await reader.read();
  assert(new TextDecoder().decode(first.value).includes("FIXTURE_READY"), "Fixture startup failed");
  reader.releaseLock();
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  // The actual desktop forwarding routes, in an isolated in-memory Hono host.
  const { Hono } = await import("hono");
  const { cors } = await import("hono/cors");
  const { default: routes } = await import("../../apps/backend/src/routes/environment-secrets.ts");
  const { setCloudRuntimeCredentials, resetCloudConfigForTests } =
    await import("../../apps/backend/src/services/agent/cloud/config.ts");
  const app = new Hono().use("*", cors()).route("/api", routes);
  setCloudRuntimeCredentials({
    baseUrl: fixture.baseUrl,
    orgId: fixture.ids.org,
    deusCloudSessionToken: fixture.tokens.alice,
  });
  proxy = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
  const entry = path.join(directory, "entry.tsx");
  await writeFile(
    entry,
    `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClientProvider } from "@tanstack/react-query";
    import { queryClient } from "@/shared/api/queryClient";
    import { CloudApplicationSecrets } from "@/features/settings/ui/sections/CloudApplicationSecrets";
    import "@/global.css";
    window.secretCacheContains = value => JSON.stringify([queryClient.getQueryCache().getAll().map(q => q.state.data), queryClient.getMutationCache().getAll().map(m => m.state)]).includes(value);
    createRoot(document.getElementById("root")).render(<React.StrictMode><QueryClientProvider client={queryClient}><main className="mx-auto max-w-2xl p-8"><CloudApplicationSecrets /></main></QueryClientProvider></React.StrictMode>);
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
          },
          load(id) {
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
    await page.addInitScript(
      (token) => sessionStorage.setItem("deus_cloud_session", token),
      fixture.tokens.alice
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(vite.resolvedUrls.local[0]);
    await page.getByLabel("Environment", { exact: true }).click();
    await page.getByRole("option", { name: "Example app", exact: true }).click();
    await page.getByRole("button", { name: "Set value", exact: true }).click();
    const value = `ui-${direct ? "web" : "desktop"}-${crypto.randomUUID()}`;
    await page.getByLabel("Value", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await page.getByText("All values set", { exact: true }).waitFor();
    assert.equal(await page.evaluate((v) => window.secretCacheContains(v), value), false);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    await page.screenshot({
      path: path.join(directory, `${direct ? "web" : "desktop"}-set.png`),
      fullPage: true,
    });
    await page.getByLabel("Organization", { exact: true }).click();
    await page.getByRole("option", { name: "Another organization", exact: true }).click();
    await page.getByText("No application secrets in this scope yet.", { exact: true }).waitFor();
    await page.getByLabel("Organization", { exact: true }).click();
    await page.getByRole("option", { name: "Secret test organization", exact: true }).click();
    await page.getByLabel("Environment", { exact: true }).click();
    await page.getByRole("option", { name: "Example app", exact: true }).click();
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
      await page.getByLabel("Environment", { exact: true }).click();
      await page.getByRole("option", { name: "Example app", exact: true }).click();
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
    assert.deepEqual(errors, []);
    await page.close();
    await vite.close();
    vite = null;
    console.log(
      `${direct ? "Direct web" : "Desktop proxy"}: save → org/account isolation → replace → delete; no values in caches`
    );
  }
  resetCloudConfigForTests();
} finally {
  await browser?.close();
  await vite?.close();
  proxy?.stop(true);
  processFixture.kill("SIGTERM");
  await processFixture.exited;
  await writeFile(fixtureFile, JSON.stringify({ retired: true }));
}
