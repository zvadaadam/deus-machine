// Account-bound remote access, end to end on loopback: Postgres, Deus Cloud
// (linked AGNT worktree), the relay Worker, Deus backends, @deus/runtime-client
// and the real web app in Chromium. No production service or real account.
//   AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:remote-access
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SignJWT, decodeJwt, importJWK } from "jose";
import { WebSocket as NodeSocket } from "ws";
import { RELAY_PROTOCOL } from "../../../shared/types/relay.ts";
import { connectBackend } from "../lib/operations.mjs";
import { failure } from "./commands.mjs";
import { createLab } from "./lab.mjs";
import { pause, until } from "./stack.mjs";
import { testBrowser } from "./browser.mjs";

const agnt = process.env.AGNT_WORKSPACE;
assert(agnt, "Set AGNT_WORKSPACE to the linked AGNT worktree (Deus Cloud runs from it)");
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/remote-access");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = { directory, checks: [] };
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS: ${name}`);
};

const lab = createLab({ root, agnt, directory });
const { stack, cloudApi, clientTicket, pair, code, signIn, relayStatus, connectedAs, spawnToken } =
  lab;
try {
  await lab.up();
  const { sessions, hostDb, signingKey } = lab;
  for (const session of Object.values(sessions)) {
    const { exp, iat } = decodeJwt(session);
    assert.equal(exp - iat, 24 * 60 * 60, "fixture sessions last 24 hours");
  }

  // ---- 1. Registration ----
  assert.equal((await relayStatus()).state, "signed_out");
  // Only the desktop process that spawned the backend may sign it in to an account.
  const foreignPush = await fetch(`${lab.host.url}/api/settings/cloud/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deusCloudUrl: lab.cloud.base,
      deusCloudSessionToken: sessions.bobDesktop,
    }),
  });
  assert.equal(foreignPush.status, 401);
  await signIn(sessions.aliceDesktop);
  const machineA = (await connectedAs("user_alice")).serverId;
  assert.match(machineA, /^[0-9a-f]{16}$/);
  const aliceList = await cloudApi(sessions.aliceWeb, "/me/machines");
  assert.deepEqual(
    aliceList.data.items.map(({ id, name }) => ({ id, name })),
    [{ id: machineA, name: "Studio Mac" }]
  );
  assert.deepEqual((await cloudApi(sessions.bobWeb, "/me/machines")).data.items, []);
  check(
    "Turning on remote access registers the Mac under its signed-in account only, and only its own app can sign it in"
  );

  // Defined by the protocol run; it removes the computer, so it runs after the browser checks.
  let removalCheck = null;
  // REMOTE_ACCESS_E2E_BROWSER_ONLY=1 skips straight to the web app (faster iteration).
  protocol: {
    if (process.env.REMOTE_ACCESS_E2E_BROWSER_ONLY) break protocol;
    // ---- 2. Deus Cloud refusals ----
    assert.equal(
      (await cloudApi(sessions.bobWeb, `/me/machines/${machineA}/tickets`, { role: "client" }))
        .status,
      404
    );
    const browserHost = await cloudApi(sessions.aliceWeb, `/me/machines/${machineA}/tickets`, {
      role: "host",
      secret: "x".repeat(43),
    });
    assert.equal(browserHost.status, 403);
    const guessedSecret = await cloudApi(
      sessions.aliceDesktop,
      `/me/machines/${machineA}/tickets`,
      {
        role: "host",
        secret: "x".repeat(43),
      }
    );
    assert.equal(guessedSecret.data.error, "MACHINE_SECRET_MISMATCH");
    check(
      "Deus Cloud gives another account nothing, and hosting needs the desktop app plus the Mac's own secret"
    );

    // ---- 3. Relay refusals ----
    const upgrade = (machineId, route, protocols) =>
      new Promise((resolve) => {
        const ws = new NodeSocket(`${lab.relay.ws}/api/servers/${machineId}/${route}`, protocols);
        ws.on("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode);
        });
        ws.on("open", () => {
          resolve(101);
          ws.close();
        });
        ws.on("error", () => {});
      });
    assert.equal(await upgrade(machineA, "connect"), 401);
    assert.equal(await upgrade(machineA, "connect", [RELAY_PROTOCOL, "garbage"]), 401);
    const ticket = await clientTicket(sessions.aliceWeb, machineA);
    assert.equal(await upgrade(machineA, "tunnel", [RELAY_PROTOCOL, ticket]), 403);
    assert.equal(await upgrade("fedcba9876543210", "connect", [RELAY_PROTOCOL, ticket]), 403);
    assert.equal(await upgrade(machineA, "connect", [RELAY_PROTOCOL, ticket]), 101);
    assert.equal(await upgrade(machineA, "connect", [RELAY_PROTOCOL, ticket]), 401);
    // Defense in depth: even a correctly signed ticket for another account cannot
    // claim a machine the relay has pinned (as if Deus Cloud itself erred).
    const key = await importJWK(JSON.parse(signingKey), "ES256");
    /** A ticket signed with this run's key, as Deus Cloud would; for relay-only checks. */
    const signTicket = (claims) =>
      new SignJWT({ mid: claims.mid, role: claims.role })
        .setProtectedHeader({
          alg: "ES256",
          typ: "deus-relay-ticket+jwt",
          kid: JSON.parse(signingKey).kid,
        })
        .setIssuer("deus-cloud")
        .setAudience("deus-relay")
        .setSubject(claims.sub)
        .setJti(claims.jti ?? crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(claims.exp ?? "1m")
        .sign(key);
    const forged = await signTicket({ sub: "user_bob", mid: machineA, role: "host" });
    assert.equal(await upgrade(machineA, "tunnel", [RELAY_PROTOCOL, forged]), 403);
    // In the real Durable Object runtime: two accounts racing to host one unclaimed
    // machine, and one ticket presented twice at once, each admit exactly one socket.
    const unclaimed = "0f0f0f0f0f0f0f0f";
    const racers = await Promise.all(
      ["user_racer_a", "user_racer_b"].map(async (sub) =>
        upgrade(unclaimed, "tunnel", [
          RELAY_PROTOCOL,
          await signTicket({ sub, mid: unclaimed, role: "host" }),
        ])
      )
    );
    assert.deepEqual([...racers].sort(), [101, 403]);
    const twice = await clientTicket(sessions.aliceWeb, machineA);
    const replays = await Promise.all([
      upgrade(machineA, "connect", [RELAY_PROTOCOL, twice]),
      upgrade(machineA, "connect", [RELAY_PROTOCOL, twice]),
    ]);
    assert.deepEqual([...replays].sort(), [101, 401]);
    // A ticket that expires on the way is refused; the next dial just gets a new one.
    const shortLived = await signTicket({
      sub: "user_alice",
      mid: machineA,
      role: "client",
      exp: Math.floor(Date.now() / 1000) + 1,
    });
    await pause(2_000);
    assert.equal(await upgrade(machineA, "connect", [RELAY_PROTOCOL, shortLived]), 401);
    check(
      "The relay refuses sockets without a valid, unused ticket for that machine and role, keeps its owner, and serializes races"
    );

    // ---- 4. Pairing ----
    const firstCode = await code();
    const grantA = await pair(sessions.aliceWeb, machineA, firstCode, "Device A");
    await assert.rejects(
      pair(sessions.aliceWeb, machineA, firstCode, "Reused"),
      /Invalid or expired/
    );
    const grantB = await pair(sessions.aliceWeb, machineA, await code(), "Device B");
    const devices = await lab.hostDevices();
    assert.deepEqual(devices.map((device) => [device.name, device.account_id]).sort(), [
      ["Device A", "user_alice"],
      ["Device B", "user_alice"],
    ]);
    check("One-use pairing through the relay approves the device for the signed-in account");

    // ---- 5. Live reads and writes ----
    const viewer = (name, options) => {
      const device = lab.viewer(name, options);
      device.runtime.retainQuery("workspaces", {}, ["workspaces"]);
      return device;
    };
    const events = (device, event) => device.log.filter((entry) => entry.event === event);
    const workspaceTitle = (groups) =>
      groups?.flatMap((group) => group.workspaces).find((row) => row.id === hostDb.workspace)
        ?.title;
    const title = (v) => workspaceTitle(v.cache.getQueryData(["workspaces"]));
    const rename = async (v, next) =>
      (
        await v.runtime.sendMutate("updateWorkspaceTitle", {
          workspaceId: hostDb.workspace,
          title: next,
        })
      ).success;
    const a = viewer("A", { bearer: sessions.aliceWeb, grant: grantA, machineId: machineA });
    const b = viewer("B", { bearer: sessions.aliceWeb, grant: grantB, machineId: machineA });
    await Promise.all([a.runtime.connect(), b.runtime.connect()]);
    await until(() => title(a) === "Before restart" && title(b) === "Before restart");
    assert.equal(await rename(a, "Through the relay"), true);
    await until(() => title(a) === "Through the relay" && title(b) === "Through the relay");
    await until(() => events(a, "send").some((entry) => entry.frame === "ping"));
    check("Two approved devices read, subscribe, write and answer probes through the relay");

    const workspace = await a.runtime.sendRequest("workspace", { workspaceId: hostDb.workspace });
    const repos = await b.runtime.sendRequest("repos");
    const db = new Database(hostDb.database, { fileMustExist: true });
    const setTitle = db.prepare("UPDATE workspaces SET title = ? WHERE id = ?");
    try {
      // The title alone exceeds the relay's message limit.
      setTitle.run("x".repeat(33 * 1024 * 1024), hostDb.workspace);
      const [, rows] = await Promise.all([
        assert.rejects(
          a.runtime.sendRequest("workspace", { workspaceId: hostDb.workspace }),
          (err) => err.kind === "rejected" && /answer is too large/i.test(err.message)
        ),
        b.runtime.sendRequest("repos"),
      ]);
      assert.deepEqual(rows, repos);
    } finally {
      setTitle.run(workspace.title, hostDb.workspace);
      db.close();
    }
    assert.deepEqual(await b.runtime.sendRequest("repos"), repos);
    assert.equal(
      (await a.runtime.sendRequest("workspace", { workspaceId: hostDb.workspace })).title,
      workspace.title
    );
    assert.deepEqual([events(a, "close"), events(b, "close")], [[], []]);
    check(
      "An oversized workspace read gets its own error while both viewers keep their connections"
    );

    // A slow Deus Cloud (700ms each way on every ticket request) only slows dialing.
    const slowCloud = viewer("Slow Cloud", {
      bearer: sessions.aliceDesktop,
      grant: grantA,
      machineId: machineA,
    });
    assert.equal(slowCloud.runtime.identity.account, "user_alice");
    lab.latencyMs = 700;
    await slowCloud.runtime.connect();
    await until(() => title(slowCloud) === "Through the relay");
    const dial = events(slowCloud, "dial").at(-1);
    const open = events(slowCloud, "open").at(-1);
    assert.ok(open.ms - dial.ms >= 2 * lab.latencyMs, "the dial includes both ticket delays");
    lab.latencyMs = 0;
    const waitForRevocation = slowCloud
      .wait("revoked", AbortSignal.timeout(500))
      .catch((error) => failure(error, true));
    const followEntries = [],
      snapshots = [],
      terminal = [];
    const live = slowCloud.follow("workspaces", {}, (entry) => {
      followEntries.push(entry);
      if (entry.event === "snapshot") snapshots.push(workspaceTitle(entry.data));
    });
    const terminalId = { id: "follow-across-reconnect" };
    const output = slowCloud.follow("terminalOutput", terminalId, (entry) => {
      followEntries.push(entry);
      terminal.push(entry.event === "event" ? entry.data.type : entry.event);
    });
    const subscribedSince = (seq) =>
      slowCloud.state(seq).entries.some((e) => e.frame === "q:subscribed");
    const echo = async () =>
      assert.equal(
        (await b.runtime.sendMutate("ptySpawn", { ...terminalId, command: "/bin/echo" })).success,
        true
      );
    await until(() => snapshots.includes("Through the relay") && subscribedSince(0));
    const expired = await waitForRevocation;
    assert.equal(expired.exitCode, 2, "a timed-out wait can be observed again");
    assert.equal(expired.state, "online");
    assert.ok(expired.entries.some((e) => e.frame === "q:subscribe"));
    await echo();
    await until(() => terminal.includes("exit"));
    const cursor = slowCloud.log.at(-1).seq;
    slowCloud.blackhole = true;
    await rename(b, "While the phone sleeps");
    const silent = await slowCloud.wait("offline", AbortSignal.timeout(8_000));
    assert.equal(silent.state, "offline");
    const during = slowCloud.state(cursor).entries;
    assert.deepEqual(slowCloud.state(cursor).entries, during, "reading never consumes entries");
    assert.equal(during[0].seq, cursor + 1);
    assert.ok(during.every((entry) => entry.event !== "receive" && entry.event !== "send"));
    slowCloud.blackhole = false;
    await slowCloud.wait("online", AbortSignal.timeout(15_000));
    await until(
      () => snapshots.includes("While the phone sleeps") && subscribedSince(cursor),
      15_000,
      "fresh snapshot and renewed stream subscription"
    );
    await echo();
    await until(() => terminal.filter((event) => event === "exit").length === 2);
    assert.deepEqual(
      terminal.filter((event) => event !== "data"),
      ["exit", "reset", "exit"]
    );
    for (const { seq, ms, event } of followEntries) {
      assert.deepEqual(
        slowCloud.log[seq - 1],
        {
          seq,
          ms,
          event: "receive",
          frame: event === "reset" ? "authenticated" : `q:${event}`,
        },
        "each follow line identifies its incoming frame"
      );
    }
    live.stop();
    output.stop();
    slowCloud.runtime.dispose();
    await rename(b, "Through the relay");
    check(
      "A slow Deus Cloud only delays dialing. After a silent connection recovers, the workspace follow gets the new title and the terminal follow reports a reset before new output"
    );

    // ---- 6. Slow authentication ----
    let delayed = false;
    const slow = viewer("Slow B", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
      wrapSocket(socket) {
        const send = socket.send.bind(socket);
        socket.send = (raw) => {
          if (delayed || JSON.parse(raw).type !== "authenticate") return send(raw);
          delayed = true;
          const timer = setTimeout(() => socket.readyState === 1 && send(raw), 6_000);
          socket.addEventListener("close", () => clearTimeout(timer));
        };
        return socket;
      },
    });
    await assert.rejects(slow.runtime.connect(), (error) => error.kind === "unavailable");
    await until(() => slow.runtime.isConnected(), 30_000, "slow viewer");
    assert.equal(events(slow, "dial").length, 2);
    assert.equal(events(slow, "auth-failure").length, 0);
    slow.runtime.dispose();
    check(
      "A six-second authentication delay redials with a fresh ticket without revoking the grant"
    );

    // ---- 7/8. Host offline and restart ----
    await lab.stop("host");
    await until(() => a.runtime.getState() === "offline" && b.runtime.getState() === "offline");
    const waiting = viewer("Waiting B", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
    });
    await assert.rejects(waiting.runtime.connect(), (error) => error.kind === "unavailable");
    await pause(1_500);
    assert.equal(title(a), "Through the relay");
    await assert.rejects(a.runtime.sendMutate("stopSession", {}), (e) => e.kind === "unavailable");
    // Pairing needs the Mac itself. The relay says so on the socket: a browser
    // cannot read a refused upgrade's status.
    await assert.rejects(
      pair(sessions.aliceWeb, machineA, "ABLE ACID", "While offline"),
      /This computer is offline/
    );
    check(
      "An offline Mac keeps viewers connected to the relay but blocks writes; new viewers wait"
    );

    await lab.startHost();
    await signIn(sessions.aliceDesktop);
    assert.equal((await connectedAs("user_alice")).serverId, machineA);
    await until(
      () => [a, b, waiting].every((v) => v.runtime.isConnected()),
      30_000,
      "viewers back"
    );
    assert.equal(await rename(a, "After host restart"), true);
    await until(() => [a, b, waiting].every((v) => title(v) === "After host restart"));
    assert.equal(events(a, "auth-failure").length + events(b, "auth-failure").length, 0);
    check(
      "A restarted Mac keeps its machine; viewers reconnect with fresh tickets and the same grants"
    );

    // ---- 9. Deus Cloud outage ----
    await lab.stop("cloud");
    assert.equal(await rename(b, "During the Cloud outage"), true);
    await until(() => title(a) === "During the Cloud outage");
    const duringOutage = viewer("During outage", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
    });
    await assert.rejects(duringOutage.runtime.connect(), (error) => error.kind === "unavailable");
    await lab.startCloud();
    await until(() => duringOutage.runtime.isConnected(), 30_000, "viewer after Cloud returns");
    await until(() => title(duringOutage) === "During the Cloud outage");
    check("A Deus Cloud outage leaves live connections working; new dials succeed once it returns");

    // ---- 10. Relay restart ----
    await lab.stop("relay");
    await until(() => a.runtime.getState() !== "online");
    const duringRelayOutage = viewer("During relay outage", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
    });
    await assert.rejects(duringRelayOutage.runtime.connect(), (e) => e.kind === "unavailable");
    await lab.startRelay();
    await connectedAs("user_alice");
    await until(
      () => [a, b, duringRelayOutage].every((v) => v.runtime.isConnected()),
      45_000,
      "viewers after relay"
    );
    const forgedAgain = await signTicket({ sub: "user_bob", mid: machineA, role: "host" });
    assert.equal(await upgrade(machineA, "tunnel", [RELAY_PROTOCOL, forgedAgain]), 403);
    check(
      "After a relay restart the Mac and viewers reconnect, and the machine's owner is still pinned"
    );

    // ---- 11. Account switch on the Mac ----
    await signIn(sessions.bobDesktop);
    const machineB = (await connectedAs("user_bob")).serverId;
    assert.notEqual(machineB, machineA);
    await until(() => a.runtime.getState() === "offline", 15_000, "Alice viewers lose the Mac");
    assert.equal(
      (await cloudApi(sessions.aliceWeb, `/me/machines/${machineB}/tickets`, { role: "client" }))
        .status,
      404
    );
    const grantBob = await pair(sessions.bobWeb, machineB, await code(), "Bob's phone");
    const bob = viewer("Bob", { bearer: sessions.bobWeb, grant: grantBob, machineId: machineB });
    await bob.runtime.connect();
    await until(() => title(bob) === "During the Cloud outage");
    await signIn(sessions.aliceDesktop);
    assert.equal((await connectedAs("user_alice")).serverId, machineA);
    await until(() => [a, b].every((v) => v.runtime.isConnected()), 30_000, "Alice back");
    assert.equal(events(a, "auth-failure").length, 0);
    await until(() => bob.runtime.getState() === "offline", 15_000, "Bob loses the Mac");
    check(
      "Signing the Mac into another account cuts the first account off; signing back reuses its approvals"
    );

    // ---- 12. Revocation ----
    const listed = await lab.hostDevices();
    await lab.revoke(listed.find((d) => d.name === "Device A").id);
    await until(() => a.runtime.getState() === "revoked");
    assert.equal(a.cache.getQueryCache().getAll().length, 0);
    assert.equal(await rename(b, "Other device still works"), true);
    await until(() => title(waiting) === "Other device still works");
    const reused = viewer("Revoked grant", {
      bearer: sessions.aliceWeb,
      grant: grantA,
      machineId: machineA,
    });
    await assert.rejects(reused.runtime.connect(), (error) => error.kind === "disposed");
    check(
      "Revoking one device ends its access and its old grant; the account's other device keeps working"
    );

    // ---- 12b. Two computers in one account ----
    const laptopDb = await stack.hostDatabase("Laptop", "Laptop workspace");
    const laptop = await stack.host({
      name: "Laptop",
      ...laptopDb,
      relayUrl: lab.relay.ws,
      authToken: spawnToken,
    });
    await signIn(sessions.aliceDesktop, laptop);
    const { serverId: machineL } = await connectedAs("user_alice", laptop);
    assert.deepEqual(
      (await cloudApi(sessions.aliceWeb, "/me/machines")).data.items.map((m) => m.name).sort(),
      ["Laptop", "Studio Mac"]
    );
    const grantL = await pair(sessions.aliceWeb, machineL, await code(laptop), "Laptop viewer");
    const onLaptop = viewer("On laptop", {
      bearer: sessions.aliceWeb,
      grant: grantL,
      machineId: machineL,
    });
    await onLaptop.runtime.connect();
    await until(() =>
      onLaptop.cache
        .getQueryData(["workspaces"])
        ?.flatMap((group) => group.workspaces)
        .some((row) => row.title === "Laptop workspace")
    );
    // An approval is for one computer: neither grant opens the other.
    for (const [grant, machineId] of [
      [grantB, machineL],
      [grantL, machineA],
    ]) {
      const crossed = viewer("Crossed " + machineId, {
        bearer: sessions.aliceWeb,
        grant,
        machineId,
      });
      await assert.rejects(crossed.runtime.connect(), (e) => e.kind === "disposed");
    }
    onLaptop.runtime.dispose();
    await stack.stop(laptop);
    check(
      "Two computers in one account each approve their own devices; a grant opens only its own"
    );

    // ---- 13. Direct LAN access (no relay, no account) ----
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (address) {
      const remote = new URL(lab.host.url);
      remote.hostname = address;
      assert.equal((await fetch(`${remote.origin}/api/relay/status`)).status, 401);
      const response = await fetch(`${remote.origin}/api/remote-auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: await code(), deviceName: "LAN tablet" }),
      });
      const { token } = await response.json();
      const tablet = await connectBackend(remote.origin, { token });
      const settings = await tablet.read("settings").finally(tablet.close);
      assert(!("relay_machines" in settings), "machine secrets must not be served");
      check("Direct LAN access still needs a pairing, and settings never expose the Mac's secrets");
    } else {
      report.skipped = "Direct LAN access: no non-loopback IPv4 interface";
    }
    removalCheck = async () => {
      const removed = await cloudApi(
        sessions.aliceWeb,
        `/me/machines/${machineA}`,
        undefined,
        "DELETE"
      );
      assert.equal(removed.status, 200);
      await lab.stop("host");
      await lab.startHost();
      await signIn(sessions.aliceDesktop);
      await until(async () => (await relayStatus()).state === "removed", 30_000, "removed state");
      // Only that computer leaves the account; the laptop from 12b stays.
      assert.deepEqual(
        (await cloudApi(sessions.aliceWeb, "/me/machines")).data.items.map((m) => m.id),
        [machineL]
      );
      // A connected viewer just waits for the computer; its next dial is refused.
      assert.notEqual(b.runtime.getState(), "online");
      const afterRemoval = viewer("After removal", {
        bearer: sessions.aliceWeb,
        grant: grantB,
        machineId: machineA,
      });
      await assert.rejects(afterRemoval.runtime.connect(), (error) => error.kind === "disposed");
      await lab.host.write("saveSetting", { key: "remote_access_enabled", value: true });
      const machineAgain = (await connectedAs("user_alice")).serverId;
      assert.notEqual(machineAgain, machineA);
      const stale = viewer("Grant for the removed machine", {
        bearer: sessions.aliceWeb,
        grant: grantB,
        machineId: machineAgain,
      });
      await assert.rejects(stale.runtime.connect(), (error) => error.kind === "disposed");
      check(
        "Removing a computer keeps it off through a restart and retires its grants, leaving the account's other computer; turning remote access on adds it anew"
      );
    };
  }

  // ---- 14. The real web app ----
  await testBrowser({
    root,
    directory,
    output,
    check,
    hostDb,
    relayUrl: lab.relay.ws,
    cloudUrl: lab.cloud.base,
    machineId: machineA,
    sessions,
    pairCode: code,
    hostApi: lab.host.api,
    hostWrite: lab.host.write,
    hostUrl: lab.host.url,
  });

  // ---- 15. Removing the computer from the account (needs the protocol run's viewers) ----
  await removalCheck?.();

  report.viewers = [...lab.devices.values()].map(({ runtime }) => runtime.diagnostics());
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  await lab.close();
}
