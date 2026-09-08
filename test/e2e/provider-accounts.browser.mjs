// Component journey against a fake cloud API; no real login or provider calls.
// Run: bun test/e2e/provider-accounts.browser.mjs (Playwright Chromium installed).
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { toCamelCaseKeys, toSnakeCaseKeys } from "@deus-hq/api";

const root = path.resolve(import.meta.dirname, "../..");
const fixturePath = path.join(root, ".context/provider-accounts-ui");
await mkdir(fixturePath, { recursive: true });
await writeFile(
  path.join(fixturePath, "entry.tsx"),
  `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/shared/api/queryClient";
import { ProviderAccounts } from "@/features/settings/ui/sections/ProviderAccounts";
window.accountCacheContains = (value: string) => JSON.stringify([queryClient.getQueryCache().getAll().map(q => q.state.data), queryClient.getMutationCache().getAll().map(m => m.state)]).includes(value);
window.refreshProviderAccounts = () => queryClient.invalidateQueries({ queryKey: ["settings", "provider-accounts"] });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><ProviderAccounts /></QueryClientProvider>);
`
);
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(fixturePath, "entry.tsx")] },
  define: {
    "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("1"),
    "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify("https://cloud.test"),
  },
  resolve: {
    alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
  },
  plugins: [
    {
      name: "provider-accounts-native-boundary",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("platform/native/deus-cloud")) return "\0native-fixture";
      },
      load(id) {
        if (id !== "\0native-fixture") return;
        return `
          export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/native/deus-cloud.ts"))};
          const listeners = new Set();
          let id = "user-a";
          const session = () => ({ signedIn: true, accountId: id, cloudUrl: "https://cloud.test", hasPlatformKey: false, expiresAt: null, tokenType: "Bearer" });
          export const getSession = async () => session();
          export function onAuthChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
          window.switchDeusAccount = next => { id = next; sessionStorage.setItem("deus_cloud_session", next); for (const fn of listeners) fn(session()); };
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><html><body><main id="root"></main><script type="module" src="/.context/provider-accounts-ui/entry.tsx"></script></body></html>'
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => sessionStorage.setItem("deus_cloud_session", "user-a"));
  const errors = [];
  const refWarnings = [];
  page.on("console", (message) => {
    if (message.text().includes("Function components cannot be given refs"))
      refWarnings.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  const personal = {
    id: "personal",
    provider: "codex",
    authMethod: "subscription",
    label: "Personal",
    email: "personal@example.com",
    planType: "plus",
    status: "connected",
    isDefault: true,
  };
  const work = {
    id: "work",
    provider: "codex",
    authMethod: "subscription",
    label: "Work",
    email: "work@example.com",
    planType: "pro",
    status: "connected",
    isDefault: false,
  };
  const accounts = [personal];
  const defaultAccountIds = { codex: personal.id };
  const providers = [
    {
      id: "claude",
      name: "Claude Code",
      vendor: "Anthropic",
      authMethods: ["api_key", "subscription"],
      subscriptionName: "Claude",
      subscriptionInstructions:
        "Run this command in your terminal, then paste the token here. The token doesn't include your email, so give each account a name you recognize.",
      subscriptionTokenSetup: {
        command: "claude setup-token",
        documentationUrl:
          "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token",
      },
    },
    {
      id: "codex",
      name: "Codex",
      vendor: "OpenAI",
      authMethods: ["api_key", "subscription"],
      subscriptionName: "ChatGPT",
      subscriptionInstructions:
        "If prompted, enable Device code login in ChatGPT Settings → Security.",
    },
  ];
  const savedCredentials = [];
  const accountUpdates = [];
  let failNextRename = false;
  let failNextList = false;
  const starts = [];
  const cancelled = [];
  const events = new Map();
  const waitForEvent = async (loginId) => {
    const deadline = Date.now() + 10_000;
    while (!events.has(loginId)) {
      assert(Date.now() < deadline, `No event stream opened for ${loginId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let loginNumber = 0;
  await page.route("https://cloud.test/me/provider-accounts**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.slice("/me/provider-accounts".length);
    const json = (data) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(toSnakeCaseKeys(data)),
      });
    if (!suffix && request.method() === "GET") {
      if (failNextList) {
        failNextList = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporary outage" }),
        });
      }
      return json({
        providers,
        accounts: request.headers().authorization === "Bearer user-b" ? [] : accounts,
        defaultAccountIds:
          request.headers().authorization === "Bearer user-b" ? {} : defaultAccountIds,
      });
    }
    if (!suffix && request.method() === "POST") {
      const wireInput = request.postDataJSON();
      assert.equal(wireInput.authMethod, undefined);
      assert.equal(typeof wireInput.auth_method, "string");
      const input = toCamelCaseKeys(wireInput);
      savedCredentials.push(input);
      if (input.secret === "invalid-key" || input.secret === "invalid-token")
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "invalid_api_key",
            message:
              input.authMethod === "api_key"
                ? "This API key is invalid. Try another key."
                : "Claude rejected this token. Try again.",
          }),
        });
      const account = input.replaceAccountId
        ? accounts.find((item) => item.id === input.replaceAccountId)
        : {
            id: `${input.provider}-${input.authMethod}-${savedCredentials.length}`,
            provider: input.provider,
            authMethod: input.authMethod,
            label: input.label,
            email: null,
            planType: null,
            status: "connected",
            isDefault: false,
          };
      assert(account);
      assert.equal(account.provider, input.provider);
      assert.equal(account.authMethod, input.authMethod);
      if (input.label !== undefined) account.label = input.label;
      account.status = "connected";
      if (!input.replaceAccountId) accounts.push(account);
      if (!accounts.some((item) => item.id === defaultAccountIds[input.provider]))
        defaultAccountIds[input.provider] = account.id;
      return json({ account });
    }
    if (suffix === "/logins") {
      const loginId = `login-${++loginNumber}`;
      starts.push(toCamelCaseKeys(request.postDataJSON()));
      return json({
        loginId,
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUrl: "https://auth.openai.com/codex/device",
        expiresAt: Date.now() + 300_000,
      });
    }
    if (suffix.endsWith("/events")) {
      const loginId = suffix.split("/")[2];
      await new Promise((resolve) =>
        events.set(loginId, async (event, data) => {
          await route
            .fulfill({
              contentType: "text/event-stream",
              body: `:keepalive\n\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            })
            .catch(() => {});
          resolve();
        })
      );
      return;
    }
    if (suffix.startsWith("/logins/")) {
      cancelled.push(suffix.split("/")[2]);
      return json({ ok: true });
    }
    const account = accounts.find((item) => item.id === suffix.slice(1));
    assert(account);
    if (request.method() === "PATCH") {
      const update = toCamelCaseKeys(request.postDataJSON());
      accountUpdates.push(update);
      if (update.label !== undefined) {
        if (failNextRename) {
          failNextRename = false;
          return route.fulfill({ status: 503, json: { message: "Temporary rename failure" } });
        }
        account.label = update.label;
      }
      if (update.isDefault) defaultAccountIds[account.provider] = account.id;
      for (const item of accounts) item.isDefault = item.id === defaultAccountIds[item.provider];
      return json({ account });
    }
    if (request.method() === "DELETE") {
      accounts.splice(accounts.indexOf(account), 1);
      return json({ ok: true });
    }
    throw new Error(`Unexpected account request: ${request.method()} ${suffix}`);
  });
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const codex = page.getByRole("region", { name: "Codex cloud accounts", exact: true });
  const claude = page.getByRole("region", { name: "Claude Code cloud accounts", exact: true });
  const row = (name) => page.getByRole("group", { name: `Codex account ${name}`, exact: true });
  await row("Personal").getByText("Default", { exact: true }).waitFor();
  assert.equal(await page.getByText("Cursor", { exact: true }).count(), 0);
  await claude.getByText("claude setup-token", { exact: true }).waitFor();
  await claude.getByRole("button", { name: "API key", exact: true }).click();
  await claude.getByLabel("Claude Code account name").fill("Team");
  await claude.getByLabel("Claude Code API key", { exact: true }).fill("claude-test-key");
  await claude.getByRole("button", { name: "Add API key", exact: true }).click();
  const claudeRow = claude.getByRole("group", { name: "Claude Code account Team", exact: true });
  await claudeRow.getByText("Default", { exact: true }).waitFor();
  assert.equal(await claude.getByLabel("Claude Code API key", { exact: true }).inputValue(), "");
  assert.equal(
    await page.evaluate(() => globalThis.accountCacheContains("claude-test-key")),
    false
  );
  assert.equal(defaultAccountIds.codex, personal.id);
  const claudeDefault = defaultAccountIds.claude;

  // Replacement keeps the account reference and never restores the saved secret.
  await claudeRow.getByRole("button", { name: "Replace key", exact: true }).click();
  const claudeKey = claude.getByLabel("Claude Code API key", { exact: true });
  assert.equal(
    await claudeKey.evaluate((input) => input === input.ownerDocument.activeElement),
    true
  );
  await claudeKey.fill("cancelled-replacement-key");
  const writesBeforeCancel = savedCredentials.length;
  await claude.getByRole("button", { name: "Cancel replacement", exact: true }).click();
  assert.equal(await claudeKey.inputValue(), "");
  assert.equal(savedCredentials.length, writesBeforeCancel);
  assert.equal(
    await page.evaluate(() => globalThis.accountCacheContains("cancelled-replacement-key")),
    false
  );
  await claudeRow.getByRole("button", { name: "Replace key", exact: true }).click();
  assert.equal(await claude.getByLabel("Claude Code API key", { exact: true }).inputValue(), "");
  await claude.getByLabel("Claude Code API key", { exact: true }).fill("invalid-key");
  await claude.getByRole("button", { name: "Save replacement key", exact: true }).click();
  await claude.getByRole("alert").filter({ hasText: "API key is invalid" }).waitFor();
  assert.equal(await claude.getByLabel("Claude Code API key", { exact: true }).inputValue(), "");
  assert.equal(await page.evaluate(() => globalThis.accountCacheContains("invalid-key")), false);
  await claude.getByLabel("Claude Code API key", { exact: true }).fill("claude-replacement-key");
  await claude.getByRole("button", { name: "Save replacement key", exact: true }).click();
  await claude.getByRole("button", { name: "Add API key", exact: true }).waitFor();
  assert.equal(await claudeKey.inputValue(), "");
  assert.equal(savedCredentials.at(-1).replaceAccountId, claudeDefault);
  assert.equal(defaultAccountIds.claude, claudeDefault);
  assert.equal(
    await page.evaluate(() => globalThis.accountCacheContains("claude-replacement-key")),
    false
  );

  // Subscription tokens share the account/default/replacement flow and secret clearing.
  await claude.getByRole("button", { name: "Claude subscription", exact: true }).click();
  assert.match(
    await claude.getByRole("link", { name: "Setup instructions" }).getAttribute("href"),
    /code\.claude\.com/
  );
  const claudeToken = claude.getByLabel("Claude Code subscription token", { exact: true });
  await claudeToken.fill("invalid-token");
  await claude.getByRole("button", { name: "Connect Claude", exact: true }).click();
  await claude.getByRole("alert").filter({ hasText: "Claude rejected this token" }).waitFor();
  assert.equal(await claudeToken.inputValue(), "");
  assert.equal(await page.evaluate(() => globalThis.accountCacheContains("invalid-token")), false);
  for (const name of ["Personal subscription", "Work subscription"]) {
    await claude.getByLabel("Claude Code account name").fill(name);
    await claudeToken.fill(`sk-ant-oat01-${name.replaceAll(" ", "-")}`);
    await claude.getByRole("button", { name: "Connect Claude", exact: true }).click();
    await claude.getByRole("group", { name: `Claude Code account ${name}`, exact: true }).waitFor();
    assert.equal(await claudeToken.inputValue(), "");
  }
  assert.equal(defaultAccountIds.claude, claudeDefault);
  // Naming a token-only subscription never needs the token again or changes its default.
  const personalSubscription = claude.getByRole("group", {
    name: "Claude Code account Personal subscription",
    exact: true,
  });
  const credentialWrites = savedCredentials.length;
  const updatesBeforeCancel = accountUpdates.length;
  await personalSubscription.getByRole("button", { name: "Rename account" }).click();
  await personalSubscription
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill("Cancel me");
  await personalSubscription.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(accountUpdates.length, updatesBeforeCancel);
  await personalSubscription.getByRole("button", { name: "Rename account" }).click();
  const nameInput = personalSubscription.getByRole("textbox", {
    name: "Account name",
    exact: true,
  });
  assert.equal(await nameInput.inputValue(), "Personal subscription");
  await nameInput.fill("  ");
  assert.equal(
    await personalSubscription.getByRole("button", { name: "Save", exact: true }).isDisabled(),
    true
  );
  await nameInput.fill("  personal@example.com  ");
  failNextRename = true;
  await personalSubscription.getByRole("button", { name: "Save", exact: true }).click();
  await nameInput.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !globalThis.document.querySelector('input[aria-label="Account name"]').disabled
  );
  assert.equal(await nameInput.inputValue(), "  personal@example.com  ");
  await nameInput.press("Enter");
  await claude
    .getByRole("group", { name: "Claude Code account personal@example.com", exact: true })
    .waitFor();
  assert.deepEqual(accountUpdates.at(-1), { label: "personal@example.com" });
  assert.equal(savedCredentials.length, credentialWrites);
  assert.equal(defaultAccountIds.claude, claudeDefault);
  assert.match(await claude.textContent(), /The token doesn't include your email/);
  const subscriptionRow = claude.getByRole("group", {
    name: "Claude Code account Work subscription",
    exact: true,
  });
  await subscriptionRow.getByRole("button", { name: "Use by default", exact: true }).click();
  await subscriptionRow.getByText("Default", { exact: true }).waitFor();
  const selectedSubscription = defaultAccountIds.claude;
  await subscriptionRow.getByRole("button", { name: "Replace token", exact: true }).click();
  await subscriptionRow.getByRole("button", { name: "Rename account", exact: true }).click();
  await subscriptionRow
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill("Work renamed");
  await subscriptionRow.getByRole("button", { name: "Save", exact: true }).click();
  const renamedSubscription = claude.getByRole("group", {
    name: "Claude Code account Work renamed",
    exact: true,
  });
  await renamedSubscription.waitFor();
  await claudeToken.fill("sk-ant-oat01-rename-replacement");
  await claude.getByRole("button", { name: "Save replacement token", exact: true }).click();
  await claude.getByRole("button", { name: "Connect Claude", exact: true }).waitFor();
  assert.equal(
    accounts.find((account) => account.id === selectedSubscription).label,
    "Work renamed"
  );
  assert.equal(savedCredentials.at(-1).label, undefined);
  await renamedSubscription.getByRole("button", { name: "Rename account", exact: true }).click();
  await renamedSubscription
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill("Work subscription");
  await renamedSubscription.getByRole("button", { name: "Save", exact: true }).click();
  await subscriptionRow.waitFor();
  await subscriptionRow.getByRole("button", { name: "Replace token", exact: true }).click();
  assert.equal(
    await claudeToken.evaluate((input) => input === input.ownerDocument.activeElement),
    true
  );
  await claudeToken.fill("sk-ant-oat01-cancelled");
  const writesBeforeTokenCancel = savedCredentials.length;
  await claude.getByRole("button", { name: "Cancel replacement", exact: true }).click();
  assert.equal(await claudeToken.inputValue(), "");
  assert.equal(savedCredentials.length, writesBeforeTokenCancel);
  await subscriptionRow.getByRole("button", { name: "Replace token", exact: true }).click();
  await claudeToken.fill("sk-ant-oat01-work-replacement");
  await claude.getByRole("button", { name: "Save replacement token", exact: true }).click();
  await claude.getByRole("button", { name: "Connect Claude", exact: true }).waitFor();
  assert.equal(savedCredentials.at(-1).replaceAccountId, selectedSubscription);
  assert.equal(savedCredentials.at(-1).authMethod, "subscription");
  assert.equal(await page.evaluate(() => globalThis.accountCacheContains("sk-ant-oat01")), false);
  await claudeRow.getByRole("button", { name: "Use by default", exact: true }).click();
  await claudeRow.getByText("Default", { exact: true }).waitFor();

  // Codex uses the same account list for keys and subscriptions, with one default.
  await codex.getByRole("button", { name: "API key", exact: true }).click();
  await codex.getByLabel("Codex account name").fill("API work");
  await codex.getByLabel("Codex API key", { exact: true }).fill("codex-test-key");
  await codex.getByRole("button", { name: "Add API key", exact: true }).click();
  await row("API work").getByRole("button", { name: "Use by default" }).click();
  await row("API work").getByText("Default", { exact: true }).waitFor();
  assert.equal(await codex.getByLabel("Codex API key", { exact: true }).inputValue(), "");
  assert.equal(defaultAccountIds.claude, claudeDefault);
  assert.equal(await page.evaluate(() => globalThis.accountCacheContains("codex-test-key")), false);
  await row("Personal").getByRole("button", { name: "Use by default" }).click();
  await row("Personal").getByText("Default", { exact: true }).waitFor();
  await codex.getByRole("button", { name: "ChatGPT subscription", exact: true }).click();

  await page.getByLabel("Codex account name").fill("Work");
  await page.getByRole("button", { name: "Connect ChatGPT" }).click();
  await page.getByText("ABCD-1234", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open ChatGPT" }).getAttribute("href"),
    "https://auth.openai.com/codex/device"
  );
  assert.match(await page.textContent("body"), /Device code login/);
  const cancelledResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && response.url().endsWith("/logins/login-1")
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("ABCD-1234", { exact: true }).waitFor({ state: "hidden" });
  await cancelledResponse;
  assert.deepEqual(cancelled, ["login-1"]);
  if (events.has("login-1")) await events.get("login-1")("error", { message: "Cancelled" });

  await page.getByRole("button", { name: "Connect ChatGPT" }).click();
  await page.getByText("ABCD-1234", { exact: true }).waitFor();
  await waitForEvent("login-2");
  failNextList = true;
  await page.evaluate(() => globalThis.refreshProviderAccounts());
  await page.getByRole("alert").filter({ hasText: "Couldn't refresh saved accounts" }).waitFor();
  await page.getByText("ABCD-1234", { exact: true }).waitFor();
  accounts.push(work);
  await events.get("login-2")("connected", { account: work });
  await row("Work").getByRole("button", { name: "Use by default" }).click();
  await row("Work").getByText("Default", { exact: true }).waitFor();
  assert.equal(defaultAccountIds.codex, "work");
  assert.equal(await row("Personal").getByText("Default", { exact: true }).count(), 0);

  await row("Work").getByRole("button", { name: "Disconnect", exact: true }).click();
  await row("Work").waitFor({ state: "hidden" });
  await page.getByRole("alert").filter({ hasText: "Choose a default account" }).waitFor();
  assert.equal(defaultAccountIds.codex, "work");
  assert.equal(await row("Personal").getByText("Default", { exact: true }).count(), 0);

  // Adding is an explicit choice after disconnect; the removed row is not retained.
  await page.getByLabel("Codex account name").fill("Work");
  await page.getByRole("button", { name: "Connect ChatGPT" }).click();
  await waitForEvent("login-3");
  assert.equal(starts.at(-1).replaceAccountId, undefined);
  work.id = "work-added-again";
  accounts.push(work);
  defaultAccountIds.codex = work.id;
  await events.get("login-3")("connected", { account: work });
  await row("Work").getByText("Default", { exact: true }).waitFor();

  // A provider-revoked login retains its row and reconnects the same identity.
  work.status = "reconnect_required";
  await page.reload({ waitUntil: "domcontentloaded" });
  await row("Work").getByRole("button", { name: "Reconnect", exact: true }).click();
  await waitForEvent("login-4");
  assert.equal(starts.at(-1).replaceAccountId, "work-added-again");
  assert.equal(starts.at(-1).label, undefined);
  await events.get("login-4")("error", { message: "Use the original ChatGPT account." });
  await page.getByRole("alert").filter({ hasText: "original ChatGPT" }).waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await waitForEvent("login-5");
  assert.equal(starts.at(-1).replaceAccountId, "work-added-again");
  work.status = "connected";
  await events.get("login-5")("connected", { account: work });
  await row("Work").getByText("Connected", { exact: true }).waitFor();

  // A connected subscription can be renewed without disconnecting its default.
  await row("Work").getByRole("button", { name: "Reconnect", exact: true }).click();
  await waitForEvent("login-6");
  assert.equal(starts.at(-1).replaceAccountId, "work-added-again");
  await events.get("login-6")("connected", { account: work });
  await row("Work").getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  assert.equal(defaultAccountIds.codex, "work-added-again");

  await page.getByRole("button", { name: "Connect ChatGPT" }).click();
  await waitForEvent("login-7");
  await page.evaluate(() => globalThis.switchDeusAccount("user-b"));
  await page.getByRole("button", { name: "Connect ChatGPT", exact: true }).waitFor();
  assert.equal(await row("Personal").count(), 0);
  assert.equal(await row("Work").count(), 0);
  assert.equal(await row("API work").count(), 0);
  assert.equal(await claudeRow.count(), 0);
  assert.equal(await page.getByText("ABCD-1234", { exact: true }).count(), 0);
  await events.get("login-7")("connected", { account: work });
  assert.equal(await row("Work").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(refWarnings, []);
  console.log(
    "Provider accounts browser journey passed: Claude/Codex keys, multiple Claude subscriptions, token/key replacement, mixed defaults, device cancel/add/reconnect/retry, identity change, no secret cache."
  );
} finally {
  await browser?.close();
  await server.close();
}
