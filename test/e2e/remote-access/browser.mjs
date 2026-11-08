/* global window */
// The real web app (Vite) in a mobile Chromium against the run's Deus Cloud,
// relay and Mac. Only the WorkOS page is stood in for: its redirect returns the
// `#token=` fragment Deus Cloud's callback returns after a real sign-in.
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { until } from "./stack.mjs";

const CLIENT = "/src/platform/ws/query-protocol-client.ts";

export async function testBrowser({
  root,
  directory,
  output,
  check,
  relayUrl,
  cloudUrl,
  machineId,
  sessions,
  pairCode,
  hostApi,
  hostUrl,
}) {
  const vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: {
      "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(""),
      "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("0"),
      "import.meta.env.VITE_RELAY_URL": JSON.stringify(relayUrl),
      "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify(cloudUrl),
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  let browser;
  const errors = [];
  const consoleLog = createWriteStream(path.join(directory, "browser-console.log"));
  try {
    await vite.listen();
    const base = vite.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });

    /** A phone whose "WorkOS" sign-in returns `session`, like Deus Cloud's callback. */
    async function phone(session) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
      });
      const logins = { count: 0 };
      await context.route(`${cloudUrl}/auth/login*`, async (route) => {
        logins.count++;
        const returnTo = new URL(route.request().url()).searchParams.get("return_to");
        await route.fulfill({
          status: 302,
          headers: { location: `${returnTo}#token=${encodeURIComponent(session)}` },
        });
      });
      const open = async () => {
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) =>
          consoleLog.write(`[${message.type()}] ${message.text()}\n`)
        );
        return page;
      };
      return { context, logins, open };
    }
    /** Connected through the relay, with a real read from the Mac answered. */
    async function online(page) {
      let result = null;
      // Poll from here: navigations during sign-in replace the page's context.
      await until(
        async () => {
          result = await page.evaluate(async (module) => {
            window.remoteClient ??= await import(module);
            const runtime = window.remoteClient.getRuntimeClient();
            if (!runtime.isConnected()) return null;
            const groups = await runtime.sendRequest("workspaces");
            return {
              account: runtime.identity.account,
              host: runtime.identity.host,
              titles: groups.flatMap((group) => group.workspaces).map((row) => row.title),
            };
          }, CLIENT);
          return result !== null;
        },
        60_000,
        "the browser to read from the Mac"
      );
      return result;
    }
    const devices = async () => (await hostApi("/remote-auth/devices")).devices.length;

    // ---- QR link while signed out ----
    const alice = await phone(sessions.aliceWeb);
    const code = await pairCode();
    const before = await devices();
    const scan = await alice.open();
    await scan.goto(`${base}s/${machineId}#pair=${code.replace(" ", "+")}`);
    const first = await online(scan);
    assert.deepEqual([first.account, first.host], ["user_alice", machineId]);
    assert(first.titles.length > 0);
    assert.equal(alice.logins.count, 1);
    assert.equal(await devices(), before + 1);
    const url = scan.url();
    assert(!url.includes("pair=") && !url.includes("token="), `secrets left in ${url}`);
    await scan.getByText("Connecting...").waitFor({ state: "hidden" });
    await scan.screenshot({ path: path.join(output, "paired-mobile.png") });
    check("Scanning the QR signed out: sign in, approve once with the link's code, then connect");

    // ---- Remembered: reload, and a new tab (its own session) ----
    await scan.reload();
    assert.equal((await online(scan)).account, "user_alice");
    const tab = await alice.open();
    await tab.goto(`${base}s/${machineId}`);
    assert.equal((await online(tab)).account, "user_alice");
    assert.equal(await devices(), before + 1);
    assert.equal(alice.logins.count, 2);
    check("A reload, and a new tab that signs in again, reconnect without a code or a new device");

    // ---- A QR link reopened on a browser that is already approved ----
    const rescan = await alice.open();
    await rescan.goto(`${base}s/${machineId}#pair=${(await pairCode()).replace(" ", "+")}`);
    await online(rescan);
    assert.equal(await devices(), before + 1);
    await until(async () => !rescan.url().includes("pair="), 10_000, "spare code scrubbed");
    check("Reopening a QR link on an approved browser connects without spending the code");

    // ---- The account's computers ----
    const list = await alice.open();
    await list.goto(`${base}s/${machineId}`);
    await online(list);
    await list.goto(`${base}connect`);
    await list.getByText("Studio Mac").click();
    assert.equal((await online(list)).host, machineId);
    await list.goto(`${base}connect`);
    await list.getByText("Studio Mac").waitFor();
    await list.screenshot({ path: path.join(output, "computers-mobile.png") });
    check("/connect lists the account's computers and opens one");

    // ---- Another account ----
    const bob = await phone(sessions.bobWeb);
    const intruder = await bob.open();
    // Even holding a valid code from the Mac's screen, another account gets nowhere.
    await intruder.goto(`${base}s/${machineId}#pair=${(await pairCode()).replace(" ", "+")}`);
    await intruder.getByText("This computer isn't on your account").waitFor();
    await until(async () => !intruder.url().includes("pair="), 10_000, "foreign code scrubbed");
    await intruder.screenshot({ path: path.join(output, "other-account-mobile.png") });
    assert.equal(await devices(), before + 1);
    check(
      "Another Deus account, even with the Mac's code, sees the computer isn't on its account; nothing is paired"
    );

    // ---- Manual approval: double submit, and a pairing socket that closes with no answer ----
    const fresh = await phone(sessions.aliceWeb);
    const manual = await fresh.open();
    let dropNextPair = true;
    // Routes apply to documents loaded after this call, so it precedes the navigation.
    await manual.routeWebSocket(
      (url) => url.pathname.endsWith("/pair"),
      (route) => {
        if (dropNextPair) {
          // The relay hangs up before any answer: nothing reached the Mac.
          dropNextPair = false;
          route.onMessage(() => void route.close({ code: 1000, reason: "No result" }));
          return;
        }
        route.connectToServer();
      }
    );
    await manual.goto(`${base}s/${machineId}`);
    await manual.getByText("Approve this device").waitFor();
    const manualCode = await pairCode();
    const input = manual.getByPlaceholder("WORD WORD");
    await input.fill(manualCode);
    await input.press("Enter");
    await manual.getByText("Connection closed before pairing finished", { exact: false }).waitFor();
    assert.equal(await devices(), before + 1);
    // Never retried on its own; the person submits again (twice, quickly).
    await input.fill(manualCode);
    await Promise.all([input.press("Enter"), input.press("Enter")]);
    assert.equal((await online(manual)).account, "user_alice");
    assert.equal(await devices(), before + 2);
    check(
      "Manual approval survives a pairing socket that closes with no answer and a double submit, pairing once"
    );

    // ---- A QR scanned, then the Mac goes offline before it can approve ----
    const remoteAccess = async (value, state) => {
      await hostApi("/settings", { method: "POST", body: { key: "remote_access_enabled", value } });
      await until(async () => (await hostApi("/relay/status")).state === state, 30_000, state);
    };
    const asleep = await phone(sessions.aliceWeb);
    const late = await asleep.open();
    const lateCode = await pairCode();
    await remoteAccess(false, "off");
    await late.goto(`${base}s/${machineId}#pair=${lateCode.replace(" ", "+")}`);
    await late.getByText("This computer is offline", { exact: false }).waitFor();
    await late.screenshot({ path: path.join(output, "offline-mobile.png") });
    await remoteAccess(true, "connected");
    // The code never reached the Mac, so the same link's code still approves.
    await late.getByRole("button", { name: "Try again" }).click();
    assert.equal((await online(late)).account, "user_alice");
    assert.equal(await devices(), before + 3);
    check("A QR scanned while the Mac is offline says so; Try again pairs once the Mac is back");

    // ---- /connect while Deus Cloud is unreachable ----
    const outage = await alice.open();
    await outage.route(`${cloudUrl}/me/machines`, (route) => route.abort());
    await outage.goto(`${base}connect`);
    // A new tab has its own session; /connect signs in from its own button.
    await outage.getByRole("button", { name: "Sign in" }).click();
    await outage.getByRole("button", { name: "Try again" }).waitFor();
    await outage.unroute(`${cloudUrl}/me/machines`);
    await outage.getByRole("button", { name: "Try again" }).click();
    await outage.getByText("Studio Mac").waitFor();
    check(
      "/connect signs in from its own page, says when Deus Cloud is unreachable, and recovers on Try again"
    );

    // ---- Signed out, without a redirect loop ----
    const signedOut = await phone(sessions.aliceWeb);
    const gate = await signedOut.open();
    await gate.addInitScript(() => {
      // As right after a sign-in attempt: the loop guard holds the redirect.
      sessionStorage.setItem("deus.cloudLoginAt", String(Date.now()));
    });
    await gate.goto(`${base}s/${machineId}`);
    await gate.getByText("Sign in to reach your computer").waitFor();
    await gate.screenshot({ path: path.join(output, "sign-in-mobile.png") });
    assert.equal(signedOut.logins.count, 0);
    await gate.getByRole("button", { name: "Sign in" }).click();
    await gate.getByText("Approve this device").waitFor();
    const fingerprint = `${machineId.slice(0, 4)} ${machineId.slice(4, 8)}`;
    await gate.getByText(fingerprint, { exact: false }).waitFor();
    check(
      "Signed out: one tap signs in; a browser this account never approved must pair, and sees which computer"
    );

    // ---- The Mac's own Settings → Remote access (desktop UI against its backend) ----
    const desktopUi = await createServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      cacheDir: path.join(directory, "vite-cache-desktop"),
      logLevel: "error",
      define: {
        "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(new URL(hostUrl).port),
        "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("0"),
        "import.meta.env.VITE_DEUS_APP_URL": JSON.stringify("https://deusmachine.ai"),
      },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
    });
    try {
      await desktopUi.listen();
      const mac = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      mac.setDefaultTimeout(60_000);
      await mac.goto(`${desktopUi.resolvedUrls.local[0]}s/local/settings`);
      await mac.evaluate(async () =>
        (await import("/src/shared/stores/uiStore.ts")).useUIStore
          .getState()
          .setActiveSettingsSection("access")
      );
      await mac.getByText("https://deusmachine.ai/connect").waitFor();
      await mac.screenshot({ path: path.join(output, "mac-remote-access.png") });
      await mac.getByRole("button", { name: "Connect a Device" }).click();
      await mac.getByText("You approve each device once.", { exact: false }).waitFor();
      await mac
        .getByText(`${machineId.slice(0, 4)} ${machineId.slice(4, 8)}`, { exact: false })
        .waitFor();
      const qr = await mac
        .locator("svg[role=img]")
        .first()
        .evaluate((svg) => svg.outerHTML.length);
      assert(qr > 1000, "the dialog draws the pairing QR code");
      await mac.screenshot({ path: path.join(output, "mac-connect-device.png") });
      await mac.close();
      check("The Mac's Remote access settings show the account link and a pairing QR");
    } finally {
      await desktopUi.close();
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    consoleLog.end();
  }
}
