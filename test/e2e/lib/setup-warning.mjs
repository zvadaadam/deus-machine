/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// Hold only this phone's retry on its way to the real backend. The other client can act first.
export async function holdSetupRetry(page) {
  const gate = Promise.withResolvers();
  let writes = 0;
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (route) => {
      const host = route.connectToServer();
      route.onMessage(async (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "q:mutate" && frame.action === "retrySetup") {
          writes++;
          await gate.promise;
        }
        host.send(raw);
      });
    }
  );
  return { writes: () => writes, release: gate.resolve };
}

// The agentless journey can render a real transcript tool by reading a finished
// turn from its disposable database. No chat or tool is executed to make the fixture.
export function seedToolTurn(db, sessionId) {
  const turn = crypto.randomUUID();
  const prompt = { type: "text", state: "done", text: "Check the workspace setup log." };
  const read = {
    type: "tool",
    kind: "read",
    toolName: "Read",
    toolCallId: crypto.randomUUID(),
    state: { status: "failed", input: { file_path: "setup.log" }, error: "File not found." },
  };
  db.transaction(() => {
    for (const [role, part] of [
      ["user", prompt],
      ["assistant", read],
    ]) {
      const message = crypto.randomUUID(),
        id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO messages (id, session_id, role, turn_id, sent_at) VALUES (?, ?, ?, ?, ?)"
      ).run(message, sessionId, role, turn, new Date().toISOString());
      db.prepare(
        "INSERT INTO parts (id, message_id, session_id, type, data, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        message,
        sessionId,
        part.type,
        JSON.stringify({ ...part, id }),
        part.toolCallId ?? null,
        part.toolName ?? null
      );
    }
    const now = Date.now();
    db.prepare(
      "INSERT INTO turns (session_id, turn_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, turn, now, now, JSON.stringify({ stopReason: "end_turn" }));
  })();
}

// Chromium's accessibility tree, with the warning and its history both open.
async function checkLiveTree(page, evidence) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Accessibility.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: '[data-slot="env-group"]:has([data-env-step="setup"])',
    });
    const { nodes } = await cdp.send("Accessibility.queryAXTree", { nodeId, role: "status" });
    const regions = [];
    for (const node of nodes) {
      assert.equal(node.properties.find((p) => p.name === "live")?.value.value, "polite");
      const children = await cdp.send("Accessibility.getChildAXNodes", { id: node.nodeId });
      regions.push(children.nodes.map((child) => [child.role.value, child.name.value]));
    }
    assert.deepEqual(regions, [
      [["StaticText", "Workspace ready"]],
      [["StaticText", "Setup failed"]],
    ]);
    await writeFile(
      path.join(evidence, "setup-warning-live-regions.json"),
      JSON.stringify(regions, null, 2)
    );
  } finally {
    await cdp.detach();
  }
}

export async function checkSetupWarning(page, group, evidence, touch = false) {
  const title = group.getByRole("button", { name: "Workspace ready, with warning", exact: true });
  const headerWarning = page
    .locator('[data-slot="workspace-header"]')
    .getByRole("button", { name: "Setup failed", exact: true });
  const retry = group.getByRole("button", { name: "Run again" });
  const log = group.getByRole("button", { name: "View log" });
  const output = group.locator("pre:visible");
  const lastLine = "Missing <b>clang</b>";
  const sentence =
    "Setup exited with code 1. The agent can see the error, and you can keep working.";
  await title.waitFor();
  await headerWarning.waitFor();
  const announcements = group.getByRole("status");
  const checkAnnouncements = async () => {
    assert.equal(
      await group.getAttribute("aria-live"),
      "off",
      "opt out of the surrounding live chat log"
    );
    assert.deepEqual(
      await Promise.all((await announcements.all()).map((region) => region.ariaSnapshot())),
      ["- status: Workspace ready", "- status: Setup failed"]
    );
    assert.equal(await group.locator('[role="status"][aria-live="polite"]').count(), 2);
  };
  await checkAnnouncements();
  assert.equal(await title.getAttribute("aria-expanded"), "false");
  await page.mouse.move(page.viewportSize().width - 120, page.viewportSize().height / 2);
  const clearFocus = () => page.evaluate(() => document.activeElement?.blur());
  await clearFocus();
  await page.locator('[data-slot="hover-card-content"]').waitFor({ state: "hidden" });
  for (const theme of touch ? ["dark"] : ["dark", "light"]) {
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: touch ? "reduce" : "no-preference",
    });
    await page.waitForFunction((name) => document.documentElement.classList.contains(name), theme);
    await page.locator("html:not([data-theme-switching])").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await output.count(), 0);
    if (!touch) await page.screenshot({ path: path.join(evidence, `setup-closed-${theme}.png`) });
    await title.press("Enter");
    await group.getByText("Made a safe copy").waitFor();
    await group.getByText(sentence, { exact: true }).waitFor();
    await clearFocus();
    const step = group.locator('[data-env-step="setup"]');
    assert.equal(await step.locator("samp").first().textContent(), lastLine);
    assert.equal(await step.locator("b").count(), 0);
    assert.equal(await output.innerText(), "Checking tools\n" + lastLine);
    assert.equal(await output.locator("b").count(), 0);
    if (!touch) await page.screenshot({ path: path.join(evidence, `setup-open-${theme}.png`) });
    await checkAnnouncements();
    if (!touch && theme === "dark") {
      await checkLiveTree(page, evidence);
      await writeFile(path.join(evidence, "setup-warning-aria.txt"), await group.ariaSnapshot());
    }
    if (touch) {
      const bounds = await retry.boundingBox();
      assert(bounds.x + bounds.width <= page.viewportSize().width);
    }

    let trigger = log;
    if (theme === "light") {
      await title.press("Enter");
      await group.getByText("Made a safe copy").waitFor({ state: "detached" });
      await headerWarning.press("Enter");
      const popover = page.locator('[data-slot="popover-content"]');
      await popover.waitFor();
      trigger = popover.getByRole("button", { name: "View log" });
    }
    const pages = page.context().pages().length;
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Setup log" });
    const fullLog = dialog.getByRole("region", { name: "Setup output" });
    await fullLog.waitFor();
    assert.equal(await fullLog.textContent(), `starting\nChecking tools\n${lastLine}\n`);
    assert.equal(await fullLog.locator("*").count(), 0, "the whole file is plain text");
    assert.equal(await fullLog.evaluate((el) => getComputedStyle(el).overflowY), "auto");
    assert.equal(page.context().pages().length, pages, "the log opens in the same window");
    if (!touch) {
      await page.screenshot({
        path: path.join(evidence, `setup-log-${theme}.png`),
        animations: "disabled",
      });
    }
    if (theme === "light") {
      await dialog.getByRole("button", { name: "Close" }).click();
      await dialog.waitFor({ state: "detached" });
      assert(
        await headerWarning.evaluate((el) => el === document.activeElement),
        "focus returns to the header warning button"
      );
    } else {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert(
        await log.evaluate((el) => el === document.activeElement),
        "focus returns to the log action"
      );
      await title.press("Space");
      await group.getByText("Made a safe copy").waitFor({ state: "detached" });
    }
    await clearFocus();
  }
}
