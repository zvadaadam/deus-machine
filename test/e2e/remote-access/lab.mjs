// Both journeys and the command line drive these same loopback processes and clients.
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { QueryClient } from "@tanstack/react-query";
import { QueryRuntimeClient } from "@deus/runtime-client/query";
import { RuntimeError } from "@deus/runtime-client";
import { WebSocket } from "ws";
import { ops, streams } from "../../../shared/api/index.ts";
import { RELAY_PROTOCOL } from "../../../shared/types/relay.ts";
import { startIssuer } from "../assistants/issuer.mjs";
import { assistantFromUrl } from "../assistants/clients.mjs";
import { createStack, freePort, until } from "./stack.mjs";

function waitForState(device, wanted, signal) {
  if (!["offline", "connecting", "online", "revoked", "disposed"].includes(wanted))
    throw new Error("Unknown device state: " + wanted);
  const since = device.log.length;
  if (!signal.aborted && device.runtime.getState() === wanted)
    return { state: wanted, entries: [device.log.findLast((e) => e.event === "state")] };
  return new Promise((resolve, reject) => {
    const end = () => {
      stop();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      end();
      const reason =
        signal.reason.name === "TimeoutError"
          ? new DOMException("Timed out waiting for " + wanted, "TimeoutError")
          : signal.reason;
      reject(Object.assign(reason, device.state(since)));
    };
    const stop = device.runtime.onStateChange((current) => {
      if (current !== wanted) return;
      end();
      resolve(device.state(since));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createLab({ root, agnt, directory }) {
  if (!agnt) throw new Error("Set AGNT_WORKSPACE to the local AGNT checkout.");
  const stack = createStack({ root, agnt, directory });
  const lifetime = new AbortController();
  const started = performance.now();
  const jwtSecret = crypto.randomUUID(),
    spawnToken = crypto.randomUUID();
  let cloudPort, relayPort, cloudUrl, jwks;
  const devices = new Map(),
    assistants = [];
  const lab = {
    stack,
    devices,
    spawnToken,
    latencyMs: 0,
    async up(seed) {
      lab.issuer = await startIssuer();
      lab.issuer.signInAs("user_alice", "org_e2e");
      lab.pg = await stack.postgres();
      lab.pg.sql(`INSERT INTO accounts (id, name, email, created_at) VALUES
        ('user_alice', 'Alice', 'alice@example.com', now()::text),
        ('user_bob', 'Bob', 'bob@example.com', now()::text)`);
      ({ jwks, signingKey: lab.signingKey } = await stack.keys());
      relayPort = await freePort();
      await lab.startRelay();
      cloudPort = await freePort();
      await lab.startCloud();
      lab.sessions = {};
      for (const account of ["alice", "bob"]) {
        for (const [suffix, client] of [
          ["Desktop", "deus-machine-desktop"],
          ["Web", "deus-web"],
        ]) {
          lab.sessions[account + suffix] = await stack.session(
            jwtSecret,
            "user_" + account,
            client
          );
        }
      }
      lab.hostDb = await stack.hostDatabase("Studio Mac", "Before restart");
      seed?.(lab.hostDb);
      await lab.startHost();
    },
    async startRelay() {
      lab.relay = await stack.relay({
        port: relayPort,
        jwks,
        persist: path.join(directory, "relay-state"),
      });
    },
    async startCloud() {
      lab.cloud = await stack.cloud({
        port: cloudPort,
        databaseUrl: lab.pg.url,
        jwtSecret,
        signingKey: lab.signingKey,
        persist: path.join(directory, "cloud-state"),
        vars: { ASSISTANT_ISSUER: lab.issuer.url, RELAY_URL: lab.relay.ws },
      });
      cloudUrl = lab.cloud.base;
    },
    async startHost() {
      lab.host = await stack.host({
        name: "Studio Mac",
        ...lab.hostDb,
        relayUrl: lab.relay.ws,
        authToken: spawnToken,
        env: { DEUS_ASSISTANT_ISSUER: lab.issuer.url, HOME: directory },
      });
    },
    async stop(part) {
      if (!lab[part]) throw new Error(part + " is already down");
      await stack.stop(lab[part]);
      lab[part] = null;
    },
    signIn(session = lab.sessions.aliceDesktop, host = lab.host) {
      return host.api("/settings/cloud/credentials", {
        method: "POST",
        headers: { authorization: `Bearer ${spawnToken}` },
        body: { deusCloudUrl: cloudUrl, deusCloudSessionToken: session },
      });
    },
    relayStatus: (host = lab.host) => host.api("/relay/status"),
    async connectedAs(accountId = "user_alice", host) {
      let status;
      await until(
        async () => {
          status = await lab.relayStatus(host);
          return status.state === "connected" && status.accountId === accountId;
        },
        30_000,
        "host connected as " + accountId
      );
      return status;
    },
    async cloudApi(bearer, route, body, method = body === undefined ? "GET" : "POST") {
      if (!lab.cloud) throw new Error("Deus Cloud is offline");
      const response = await fetch(lab.cloud.base + route, {
        method,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    },
    async clientTicket(bearer, machineId) {
      const { status, data } = await lab.cloudApi(bearer, `/me/machines/${machineId}/tickets`, {
        role: "client",
      });
      if (status !== 200) throw Object.assign(new Error(`ticket ${status}`), { status });
      return data.ticket;
    },
    code: async (host = lab.host) =>
      (await host.api("/remote-auth/generate-pair-code", { method: "POST" })).code,
    hostDevices: async () => (await lab.host.api("/remote-auth/devices")).devices,
    revoke: (deviceId) => lab.host.write("revokeDevice", { deviceId }),
    async pair(bearer, machineId, code, deviceName) {
      const ticket = await lab.clientTicket(bearer, machineId);
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${lab.relay.ws}/api/servers/${machineId}/pair`, [
          RELAY_PROTOCOL,
          ticket,
        ]);
        const timer = setTimeout(() => {
          reject(new DOMException("Pairing timed out", "TimeoutError"));
          ws.terminate();
        }, 10_000);
        ws.on("open", () => ws.send(JSON.stringify({ type: "pair_request", code, deviceName })));
        ws.once("message", (raw) => {
          try {
            const frame = JSON.parse(String(raw));
            if (frame.type !== "pair_success") throw new Error(frame.message);
            resolve(frame.token);
          } catch (error) {
            reject(error);
          }
          ws.close();
        });
        ws.on("error", reject);
        ws.on("close", () => {
          clearTimeout(timer);
          reject(new Error("Closed before pairing finished"));
        });
      });
    },
    viewer(name, { bearer, grant, machineId, wrapSocket }) {
      if (devices.has(name)) throw new Error("Device name already in use: " + name);
      const log = [];
      const record = (event, fields = {}) =>
        log.push({
          seq: log.length + 1,
          ms: Math.round(performance.now() - started),
          event,
          ...fields,
        });
      const cache = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });
      let ws;
      const device = {
        log,
        cache,
        blackhole: false,
        state(since = 0) {
          return { state: runtime.getState(), entries: log.slice(since) };
        },
        wait(wanted, signal) {
          return waitForState(device, wanted, signal);
        },
        follow(name, filter, onEntry, onRefused) {
          if (!runtime.isConnected()) throw new Error("Device is " + runtime.getState());
          const emit = (entry) => {
            // During authentication the runtime sends subscriptions before it reports a reset.
            const { seq, ms } = log.findLast((row) => row.event === "receive");
            onEntry({ seq, ms, ...entry });
          };
          const stream = streams.find((s) => s.name === name);
          if (stream) {
            const stop = runtime.listen(
              name,
              stream.scope.partial().parse(filter),
              (data) => emit({ event: "event", data }),
              {
                onReset: () => emit({ event: "reset", data: null }),
                onRefused,
              }
            );
            return { stop, live: false };
          }
          const live = ops.find((d) => d.name === name && d.live);
          if (!live) throw new Error("Unknown stream or live read: " + name);
          const stop = runtime.subscribe(
            name,
            live.input.parse(filter),
            (data) => emit({ event: "snapshot", data }),
            (upserted, removed) => emit({ event: "delta", data: { upserted, removed } })
          );
          return { stop, live: true };
        },
        drop() {
          if (ws?.readyState !== WebSocket.OPEN) throw new Error("Device socket is not open");
          ws.terminate();
        },
      };
      const runtime = new QueryRuntimeClient(
        {
          host: machineId,
          account: bearer === lab.sessions.aliceWeb ? "user_alice" : "user_bob",
          grant: name,
        },
        {
          queryClient: cache,
          authenticate: () => ({ type: "authenticate", token: grant }),
          onAuthFailure: () => record("auth-failure"),
          heartbeatIntervalMs: 300,
          heartbeatTimeoutMs: 1500,
          open: async () => {
            record("dial");
            let ticket;
            try {
              if (lab.latencyMs) await delay(lab.latencyMs, undefined, { signal: lifetime.signal });
              ticket = await lab.clientTicket(bearer, machineId);
              if (lab.latencyMs) await delay(lab.latencyMs, undefined, { signal: lifetime.signal });
            } catch (error) {
              if ([401, 403, 404].includes(error.status))
                throw new RuntimeError("rejected", error.message);
              throw error;
            }
            if (!lab.relay) throw new Error("Relay is offline");
            const socket = new WebSocket(`${lab.relay.ws}/api/servers/${machineId}/connect`, [
              RELAY_PROTOCOL,
              ticket,
            ]);
            socket.on("open", () => {
              ws = socket;
              record("open");
            });
            socket.on("close", (code) => record("close", { code }));
            // ws emits an error even if a slow dial was disposed before the runtime attached.
            socket.on("error", () => record("socket-error"));
            // Record frame types only. Pairing grants and operation payloads do not belong in state.
            const link = {
              get readyState() {
                return socket.readyState;
              },
              close: (...args) => socket.close(...args),
              send(raw) {
                if (device.blackhole) return;
                record("send", { frame: JSON.parse(raw).type });
                socket.send(raw);
              },
              addEventListener(type, listener) {
                if (type !== "message") return socket.addEventListener(type, listener);
                socket.addEventListener("message", (event) => {
                  if (device.blackhole) return;
                  let frame;
                  try {
                    frame = JSON.parse(String(event.data))?.type;
                  } catch {
                    // The runtime also receives malformed input and decides how to handle it.
                  }
                  record("receive", { frame });
                  listener(event);
                });
              },
            };
            return wrapSocket ? wrapSocket(link) : link;
          },
        }
      );
      record("state", { state: runtime.getState() });
      runtime.onStateChange((state) => record("state", { state }));
      device.runtime = runtime;
      devices.set(name, device);
      return device;
    },
    async addAssistant(name, redirect) {
      const { assistantUrl } = await lab.relayStatus();
      const assistant = await assistantFromUrl(assistantUrl, { name, redirect });
      assistants.push(assistant);
      return assistant;
    },
    async close() {
      lifetime.abort();
      for (const { runtime } of devices.values()) runtime.dispose();
      try {
        await Promise.allSettled(assistants.map((a) => a.close()));
      } finally {
        try {
          await stack.close();
        } finally {
          await lab.issuer?.close();
        }
      }
    },
  };
  return lab;
}
