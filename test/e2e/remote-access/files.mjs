/* global Image, window */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DEUS_TOOLS_SERVER } from "../../../shared/mcp-servers.ts";

async function expectFileStatus(response, ...expected) {
  const status = response.status();
  if (expected.includes(status)) return;
  const headers = response.headers();
  delete headers["set-cookie"];
  delete headers.location;
  const bodyLength = (await response.body()).length;
  assert.fail(
    `Expected HTTP ${expected.join(" or ")}, got ${JSON.stringify({ status, headers, bodyLength })}`
  );
}

// A chat with one completed recording, as it would be read after reopening the app.
function seedRecording(hostDb, outputPath, thumbnailPath) {
  const sessionId = crypto.randomUUID(),
    messageId = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const id = crypto.randomUUID(),
    now = Date.now();
  const tool = {
    id,
    messageId,
    sessionId,
    type: "tool",
    kind: "other",
    toolCallId: id,
    toolName: `mcp__${DEUS_TOOLS_SERVER}__recording_stop`,
    mcp: { server: DEUS_TOOLS_SERVER, tool: "recording_stop" },
    state: {
      status: "completed",
      input: {},
      output: JSON.stringify({
        outputPath,
        thumbnailPath,
        duration: 10,
        chapters: [
          { time: 0, title: "Opening" },
          { time: 5, title: "Review" },
        ],
      }),
      time: { start: now, end: now },
    },
  };
  const db = new Database(hostDb.database, { fileMustExist: true });
  try {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO sessions (id, workspace_id, title, message_count) VALUES (?, ?, 'Recording', 1)"
      ).run(sessionId, hostDb.workspace);
      db.prepare("UPDATE workspaces SET current_session_id = ? WHERE id = ?").run(
        sessionId,
        hostDb.workspace
      );
      db.prepare(
        "INSERT INTO messages (id, session_id, role, turn_id, sent_at) VALUES (?, ?, 'assistant', ?, ?)"
      ).run(messageId, sessionId, turnId, new Date(now).toISOString());
      db.prepare(
        "INSERT INTO parts (id, message_id, session_id, type, data, tool_call_id, tool_name) VALUES (?, ?, ?, 'tool', ?, ?, ?)"
      ).run(id, messageId, sessionId, JSON.stringify(tool), id, tool.toolName);
      db.prepare(
        "INSERT INTO turns (session_id, turn_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?)"
      ).run(sessionId, turnId, now, now, JSON.stringify({ stopReason: "end_turn" }));
    })();
  } finally {
    db.close();
  }
}

export async function testRelayedFiles({
  root,
  output,
  hostDb,
  page,
  workspaceUrl,
  relayUrl,
  revoke,
}) {
  const temp = await mkdtemp(path.join(tmpdir(), "deus-recording-"));
  try {
    const movie = path.join(temp, "recording.webm"),
      thumbnail = path.join(temp, "thumbnail.png");
    const workspace = path.join(hostDb.dir, ".deus", "remote");
    const assets = path.join(root, "apps/web/public");
    await mkdir(workspace, { recursive: true });
    await copyFile(path.join(assets, "animations/agent-dots-alpha.webm"), movie);
    await copyFile(path.join(assets, "favicon-16x16.png"), thumbnail);
    await copyFile(thumbnail, path.join(workspace, "preview.png"));
    await writeFile(path.join(workspace, "page.html"), "<title>Workspace preview</title>");
    seedRecording(hostDb, movie, thumbnail);

    const fileUrl = (input) =>
      page.evaluate(
        (params) => window.remoteClient.getRuntimeClient().sendRequest("fileUrl", params),
        input
      );
    const preview = (file) =>
      fileUrl({ kind: "preview", path: file, workspaceId: hostDb.workspace });
    const { url: movieUrl } = await fileUrl({ kind: "recording", path: movie });
    const { url: thumbnailUrl } = await fileUrl({ kind: "recording", path: thumbnail });
    const { url: imageUrl } = await preview("preview.png");
    const relayOrigin = new URL(relayUrl.replace(/^ws/, "http")).origin;
    for (const url of [movieUrl, thumbnailUrl, imageUrl])
      assert.equal(new URL(url).origin, relayOrigin);
    await assert.rejects(
      preview("page.html"),
      /HTML previews are available only on a direct connection\./
    );

    const get = async (url, status, headers) => {
      const response = await page.request.get(url, { headers, maxRedirects: 0, timeout: 15_000 });
      await expectFileStatus(response, status);
      return response;
    };
    const source = await readFile(movie);
    assert((await (await get(movieUrl, 200)).body()).equals(source), "wrong recording bytes");
    const start = Math.floor(source.length / 2),
      end = start + 63;
    const range = await get(movieUrl, 206, { Range: `bytes=${start}-${end}` });
    assert.equal(range.headers()["content-range"], `bytes ${start}-${end}/${source.length}`);
    assert(
      (await range.body()).equals(source.subarray(start, end + 1)),
      "wrong middle range bytes"
    );
    const image = await get(imageUrl, 200);
    assert((await image.body()).equals(await readFile(thumbnail)), "wrong preview bytes");
    const dimensions = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, imageUrl);
    assert.deepEqual(dimensions, [16, 16]);

    // Replace the selected inode between fileUrl and the browser's first GET.
    // The real Mac refuses that handle and issues a new one for the same path.
    async function recover(file, oldUrl, resourceType, show) {
      await page.route(
        oldUrl,
        async (route) => {
          await copyFile(file, file + ".new");
          await rename(file + ".new", file);
          await route.continue();
        },
        { times: 1 }
      );
      const [, fresh] = await Promise.all([
        page.waitForResponse((r) => r.url() === oldUrl).then((r) => expectFileStatus(r, 404)),
        page
          .waitForResponse(
            (r) =>
              new URL(r.url()).origin === relayOrigin &&
              r.url() !== oldUrl &&
              r.request().resourceType() === resourceType
          )
          .then(async (r) => {
            await expectFileStatus(r, 200, 206);
            return r.url();
          }),
        show(),
      ]);
      return fresh;
    }

    const freshThumbnail = await recover(thumbnail, thumbnailUrl, "image", () =>
      page.goto(workspaceUrl)
    );
    const thumb = page.getByRole("img", { name: "Recording thumbnail" });
    assert(
      await thumb.evaluate(async (img, fresh) => {
        await img.decode();
        return img.src === fresh && img.naturalWidth === 16;
      }, freshThumbnail),
      "the card did not load the renewed thumbnail"
    );

    const viewport = page.viewportSize();
    assert.equal(viewport.width, 390);
    async function inBounds(locator, name) {
      const box = await locator.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, name + " is visible");
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, name + " fits horizontally");
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, name + " fits vertically");
      return box;
    }
    const card = page.getByRole("button", { name: "Open recording player" });
    await card.scrollIntoViewIfNeeded();
    await inBounds(card, "recording card");
    await page.screenshot({ path: path.join(output, "recording-card-mobile.png") });
    const freshMovie = await recover(movie, movieUrl, "media", () => card.press("Enter"));
    const player = page.getByRole("dialog", { name: "Recording player" });
    const video = await player.locator("video").elementHandle();
    assert(
      await video.evaluate((v, fresh) => v.src === fresh, freshMovie),
      "the player did not use its renewed URL"
    );
    const stage = player.locator("video").locator("..");
    const seek = stage.locator("+ div");
    const chapter = player.getByRole("button", { name: "0:05 Review" });
    const close = player.getByRole("button", { name: "Close player" });
    const isFocused = (node) => node === node.ownerDocument.activeElement;
    await page.waitForFunction(isFocused, await close.elementHandle());
    await page.keyboard.press("Shift+Tab");
    assert.ok(await chapter.evaluate(isFocused), "backward Tab wraps to the last chapter");
    await page.keyboard.press("Tab");
    assert.ok(await close.evaluate(isFocused), "forward Tab stays in the player");
    await page.screenshot({ path: path.join(output, "recording-player-keyboard.png") });
    await chapter.click({ trial: true });
    await inBounds(stage.locator("svg.lucide-play"), "play control");
    const bar = await inBounds(seek, "seek bar");
    const timeline = await inBounds(player.getByText("Timeline", { exact: true }), "timeline");
    assert.ok(timeline.y >= bar.y + bar.height - 1, "chapters follow the seek bar");
    assert.ok(Math.abs(timeline.width - bar.width) <= 1, "player and timeline share the width");
    await stage.click();
    await page.waitForFunction((v) => !v.paused && v.currentTime > 0, video);
    await chapter.click();
    await page.waitForFunction((v) => !v.seeking && v.currentTime >= 5, video);
    await stage.click();
    await page.waitForFunction((v) => v.paused, video);
    await page.screenshot({ path: path.join(output, "recording-player-mobile.png") });
    await seek.click({ position: { x: bar.width / 4, y: bar.height / 2 } });
    await page.waitForFunction((v) => !v.seeking && v.currentTime >= 2 && v.currentTime < 3, video);
    await page.keyboard.press("Escape");
    await player.waitFor({ state: "detached" });
    await page.waitForFunction(isFocused, await card.elementHandle());
    await page.screenshot({ path: path.join(output, "recording-card-focus-return.png") });
    await revoke();
    await get(freshMovie, 404);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
