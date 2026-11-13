// Account-bound remote access, end to end on loopback: Postgres, Deus Cloud
// (linked AGNT worktree), the relay Worker, Deus backends, @deus/runtime-client
// and the real web app in Chromium. No production service or real account.
//   AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:remote-access
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { QueryRuntimeClient } from "@deus/runtime-client/query";
import { RuntimeError } from "@deus/runtime-client";
import { SignJWT, importJWK } from "jose";
import { WebSocket as NodeSocket } from "ws";
import { RELAY_PROTOCOL } from "../../../shared/types/relay.ts";
import { createStack, freePort, pause, until } from "./stack.mjs";
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

const stack = createStack({ root, agnt, directory });
const viewers = [];
try {
  // ---- Stack ----
  const pg = await stack.postgres();
  pg.sql(
    `INSERT INTO accounts (id, name, email, created_at) VALUES
       ('user_alice', 'Alice', 'alice@example.com', now()::text),
       ('user_bob', 'Bob', 'bob@example.com', now()::text)`
  );
  const { signingKey, jwks } = await stack.keys();
  const jwtSecret = crypto.randomUUID();
  const cloudPort = await freePort();
  const relayPort = await freePort();
  const cloudState = path.join(directory, "cloud-state");
  const relayState = path.join(directory, "relay-state");
  const startCloud = () =>
    stack.cloud({
      port: cloudPort,
      databaseUrl: pg.url,
      jwtSecret,
      signingKey,
      persist: cloudState,
    });
  const startRelay = () => stack.relay({ port: relayPort, jwks, persist: relayState });
  let cloud = await startCloud();
  let relay = await startRelay();
  const sessions = {
    aliceDesktop: await stack.session(jwtSecret, "user_alice", "deus-machine-desktop"),
    aliceWeb: await stack.session(jwtSecret, "user_alice", "deus-web"),
    bobDesktop: await stack.session(jwtSecret, "user_bob", "deus-machine-desktop"),
    bobWeb: await stack.session(jwtSecret, "user_bob", "deus-web"),
  };

  async function cloudApi(bearer, route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${cloud.base}${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }
  async function clientTicket(bearer, machineId) {
    const { status, data } = await cloudApi(bearer, `/me/machines/${machineId}/tickets`, {
      role: "client",
    });
    if (status !== 200) throw Object.assign(new Error(`ticket ${status}`), { status });
    return data.ticket;
  }

  const hostDb = await stack.hostDatabase("Studio Mac", "Before restart");
  const spawnToken = crypto.randomUUID();
  const startHost = () =>
    stack.host({ name: "Studio Mac", ...hostDb, relayUrl: relay.ws, authToken: spawnToken });
  let host = await startHost();
  const signIn = (desktopSession) =>
    host.api("/settings/cloud/credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${spawnToken}` },
      body: { deusCloudUrl: cloud.base, deusCloudSessionToken: desktopSession },
    });
  const relayStatus = () => host.api("/relay/status");
  const code = async () =>
    (await host.api("/remote-auth/generate-pair-code", { method: "POST" })).code;
  const connectedAs = async (accountId) => {
    let status;
    await until(
      async () => {
        status = await relayStatus();
        return status.state === "connected" && status.accountId === accountId;
      },
      30_000,
      `host connected as ${accountId}`
    );
    return status;
  };

  // ---- 1. Registration ----
  assert.equal((await relayStatus()).state, "signed_out");
  // Only the desktop process that spawned the backend may sign it in to an account.
  const foreignPush = await fetch(`${host.url}/api/settings/cloud/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deusCloudUrl: cloud.base, deusCloudSessionToken: sessions.bobDesktop }),
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
        const ws = new NodeSocket(`${relay.ws}/api/servers/${machineId}/${route}`, protocols);
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
    async function pair(bearer, machineId, code, deviceName) {
      const pairTicket = await clientTicket(bearer, machineId);
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${relay.ws}/api/servers/${machineId}/pair`, [
          RELAY_PROTOCOL,
          pairTicket,
        ]);
        const timer = setTimeout(() => reject(new Error("Pairing timed out")), 10_000);
        ws.addEventListener("open", () =>
          ws.send(JSON.stringify({ type: "pair_request", code, deviceName }))
        );
        ws.addEventListener("message", (event) => {
          clearTimeout(timer);
          const frame = JSON.parse(String(event.data));
          if (frame.type === "pair_success") resolve(frame.token);
          else reject(new Error(frame.message));
          ws.close();
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          reject(new Error("Closed before pairing finished"));
        });
      });
    }
    const firstCode = await code();
    const grantA = await pair(sessions.aliceWeb, machineA, firstCode, "Device A");
    await assert.rejects(
      pair(sessions.aliceWeb, machineA, firstCode, "Reused"),
      /Invalid or expired/
    );
    const grantB = await pair(sessions.aliceWeb, machineA, await code(), "Device B");
    const { devices } = await host.api("/remote-auth/devices");
    assert.deepEqual(devices.map((device) => [device.name, device.account_id]).sort(), [
      ["Device A", "user_alice"],
      ["Device B", "user_alice"],
    ]);
    check("One-use pairing through the relay approves the device for the signed-in account");

    // ---- 5. Live reads and writes ----
    function viewer(
      name,
      { bearer, grant, machineId, delayFirstAuth = false, cloudLatencyMs = 0 }
    ) {
      const cache = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });
      const frames = [];
      const counts = { opens: 0, authFailures: 0 };
      const runtime = new QueryRuntimeClient(
        { host: machineId, account: bearer.slice(-12), grant: name },
        {
          open: async () => {
            counts.opens++;
            let ticket;
            try {
              if (cloudLatencyMs) await pause(cloudLatencyMs);
              ticket = await clientTicket(bearer, machineId);
              if (cloudLatencyMs) await pause(cloudLatencyMs);
            } catch (error) {
              // As the app does: Deus Cloud refusing the account or the computer is final.
              if ([401, 403, 404].includes(error.status)) {
                throw new RuntimeError("rejected", error.message);
              }
              throw error;
            }
            const socket = new WebSocket(`${relay.ws}/api/servers/${machineId}/connect`, [
              RELAY_PROTOCOL,
              ticket,
            ]);
            const send = socket.send.bind(socket);
            socket.send = (raw) => {
              const frame = JSON.parse(raw);
              frames.push(frame.type);
              if (delayFirstAuth && counts.opens === 1 && frame.type === "authenticate") {
                const timer = setTimeout(() => socket.readyState === 1 && send(raw), 6_000);
                socket.addEventListener("close", () => clearTimeout(timer), { once: true });
              } else send(raw);
            };
            return socket;
          },
          authenticate: () => ({ type: "authenticate", token: grant }),
          queryClient: cache,
          onAuthFailure: () => counts.authFailures++,
          heartbeatIntervalMs: 300,
          heartbeatTimeoutMs: 1_500,
        }
      );
      runtime.retainQuery("workspaces", {}, ["workspaces"]);
      viewers.push(runtime);
      return { runtime, cache, frames, counts };
    }
    const title = (v) =>
      v.cache
        .getQueryData(["workspaces"])
        ?.flatMap((group) => group.workspaces)
        .find((row) => row.id === hostDb.workspace)?.title;
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
    await until(() => a.frames.includes("ping"));
    check("Two approved devices read, subscribe, write and answer probes through the relay");

    // A slow Deus Cloud (700ms each way on every ticket request) only slows dialing.
    const slowCloud = viewer("Slow Cloud", {
      bearer: sessions.aliceWeb,
      grant: grantA,
      machineId: machineA,
      cloudLatencyMs: 700,
    });
    await slowCloud.runtime.connect();
    await until(() => title(slowCloud) === "Through the relay");
    slowCloud.runtime.dispose();
    check("A slow Deus Cloud (700ms each way) only slows dialing");

    // ---- 6. Slow authentication ----
    const slow = viewer("Slow B", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
      delayFirstAuth: true,
    });
    await assert.rejects(slow.runtime.connect(), (error) => error.kind === "unavailable");
    await until(() => slow.runtime.isConnected(), 30_000, "slow viewer");
    assert.equal(slow.counts.opens, 2);
    assert.equal(slow.counts.authFailures, 0);
    slow.runtime.dispose();
    check(
      "A six-second authentication delay redials with a fresh ticket without revoking the grant"
    );

    // ---- 7/8. Host offline and restart ----
    await stack.stop(host);
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

    host = await startHost();
    await signIn(sessions.aliceDesktop);
    assert.equal((await connectedAs("user_alice")).serverId, machineA);
    await until(
      () => [a, b, waiting].every((v) => v.runtime.isConnected()),
      30_000,
      "viewers back"
    );
    assert.equal(await rename(a, "After host restart"), true);
    await until(() => [a, b, waiting].every((v) => title(v) === "After host restart"));
    assert.equal(a.counts.authFailures + b.counts.authFailures, 0);
    check(
      "A restarted Mac keeps its machine; viewers reconnect with fresh tickets and the same grants"
    );

    // ---- 9. Deus Cloud outage ----
    await stack.stop(cloud);
    assert.equal(await rename(b, "During the Cloud outage"), true);
    await until(() => title(a) === "During the Cloud outage");
    const duringOutage = viewer("During outage", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
    });
    await assert.rejects(duringOutage.runtime.connect(), (error) => error.kind === "unavailable");
    cloud = await startCloud();
    await until(() => duringOutage.runtime.isConnected(), 30_000, "viewer after Cloud returns");
    await until(() => title(duringOutage) === "During the Cloud outage");
    check("A Deus Cloud outage leaves live connections working; new dials succeed once it returns");

    // ---- 10. Relay restart ----
    await stack.stop(relay);
    await until(() => a.runtime.getState() !== "online");
    const duringRelayOutage = viewer("During relay outage", {
      bearer: sessions.aliceWeb,
      grant: grantB,
      machineId: machineA,
    });
    await assert.rejects(duringRelayOutage.runtime.connect(), (e) => e.kind === "unavailable");
    relay = await startRelay();
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
    assert.equal(a.counts.authFailures, 0);
    await until(() => bob.runtime.getState() === "offline", 15_000, "Bob loses the Mac");
    check(
      "Signing the Mac into another account cuts the first account off; signing back reuses its approvals"
    );

    // ---- 12. Revocation ----
    const listed = (await host.api("/remote-auth/devices")).devices;
    await host.api(`/remote-auth/devices/${listed.find((d) => d.name === "Device A").id}`, {
      method: "DELETE",
    });
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
      relayUrl: relay.ws,
      authToken: spawnToken,
    });
    await laptop.api("/settings/cloud/credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${spawnToken}` },
      body: { deusCloudUrl: cloud.base, deusCloudSessionToken: sessions.aliceDesktop },
    });
    let laptopStatus;
    await until(
      async () => (laptopStatus = await laptop.api("/relay/status")).state === "connected",
      30_000,
      "laptop connected"
    );
    const machineL = laptopStatus.serverId;
    assert.deepEqual(
      (await cloudApi(sessions.aliceWeb, "/me/machines")).data.items.map((m) => m.name).sort(),
      ["Laptop", "Studio Mac"]
    );
    const laptopCode = (await laptop.api("/remote-auth/generate-pair-code", { method: "POST" }))
      .code;
    const grantL = await pair(sessions.aliceWeb, machineL, laptopCode, "Laptop viewer");
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
      const crossed = viewer("Crossed", { bearer: sessions.aliceWeb, grant, machineId });
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
      const remote = new URL(host.url);
      remote.hostname = address;
      assert.equal((await fetch(`${remote.origin}/api/settings`)).status, 401);
      const response = await fetch(`${remote.origin}/api/remote-auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: await code(), deviceName: "LAN tablet" }),
      });
      const { token } = await response.json();
      const settings = await fetch(`${remote.origin}/api/settings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(settings.status, 200);
      assert(!("relay_machines" in (await settings.json())), "machine secrets must not be served");
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
      await stack.stop(host);
      host = await startHost();
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
      await host.api("/settings", {
        method: "POST",
        body: { key: "remote_access_enabled", value: true },
      });
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
    relayUrl: relay.ws,
    cloudUrl: cloud.base,
    machineId: machineA,
    sessions,
    pairCode: code,
    hostApi: host.api,
    hostUrl: host.url,
  });

  // ---- 15. Removing the computer from the account (needs the protocol run's viewers) ----
  await removalCheck?.();

  report.viewers = viewers.map((runtime) => runtime.diagnostics());
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  viewers.forEach((runtime) => runtime.dispose());
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  await stack.close();
}
