import {
  useGatewayFixture,
  db,
  dir,
  run,
  baseUrl,
  model,
  codexModel,
  key,
  probes,
  requests,
  connectHere,
  prepared,
  chat,
} from "./setup";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import * as gatewayTurn from "../../../../src/services/gateways/turn";
import { claimTurn, holdingTurn, forgetChatTurns } from "../../../../src/services/agent/chat-turn";
import * as service from "../../../../src/services/agent/service";
import { queuedMessages } from "../../../../src/services/agent/queue";
import { sendMessage, stopSession } from "../../../../src/services/agent/turns";
import { gatewayCredential, gatewayTurnEvent } from "../../../../src/services/gateways/turn";

vi.mock("../../../../src/services/gateways/turn", async (load) => {
  const original = await load<typeof gatewayTurn>();
  return { ...original, gatewayCredential: vi.fn(original.gatewayCredential) };
});

vi.mock("../../../../src/services/integrations", () => ({
  resolveTurnApps: async () => ({ servers: {}, skipped: [] }),
}));
vi.mock("../../../../../agent-server/agents/environment", () => ({
  applyShellEnvironment() {},
  getShellEnvironment: () => ({}),
}));
vi.mock("../../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession() {},
}));
let inferenceStatus: number | "unreachable" = 200;
let authorizedInference = 0;
useGatewayFixture((req, res) => {
  if (
    (req.url === "/v1/messages" && req.headers["x-api-key"] === key) ||
    (req.url === "/v1/responses" && req.headers.authorization === "Bearer " + key)
  )
    authorizedInference++;
  if (inferenceStatus === "unreachable") return req.socket.destroy();
  res.writeHead(inferenceStatus, {
    "Content-Type": "application/json",
  });
  res.end(
    inferenceStatus === 200
      ? "{}"
      : JSON.stringify({
          type: "error",
          error: {
            type:
              inferenceStatus === 429
                ? "rate_limit_error"
                : inferenceStatus === 404
                  ? "model_not_found"
                  : "authentication_error",
            message: "Fixture inference failure",
          },
        })
  );
});
const send = (sessionId: string, revision?: string) =>
  sendMessage({
    sessionId,
    turnId: crypto.randomUUID(),
    content: "local fixture",
    model,
    agentHarness: "claude-code",
    gatewayRevision: revision,
  });
const stored = (id: string) =>
  db.prepare("SELECT gateway_revision FROM sessions WHERE id=?").pluck().get(id);
const spawned = async () => JSON.parse(await readFile(join(dir, "spawn.json"), "utf8"));

async function expectNativeOnly(id: string) {
  const before = requests;
  await rm(join(dir, "spawn.json"), { force: true });
  await send(id);
  await vi.waitFor(
    async () =>
      expect(await spawned()).toEqual({
        loopback: false,
        hasAuth: false,
        placeholder: false,
        retry: null,
      }),
    { timeout: 15000 }
  );
  expect(requests).toBe(before);
  expect(queuedMessages(id).paused).toBeNull();
}

beforeAll(async () => {
  // A recording executable is the Claude SDK's actual child. Only booleans and its retry count leave it.
  const cli = join(dir, "claude.cjs");
  await writeFile(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("2.1.99 (Claude Code)"); process.exit(0); }
(async () => {
 const env = process.env, base = env.ANTHROPIC_BASE_URL, sid = crypto.randomUUID();
 const loopback = !!base && new URL(base).hostname === "127.0.0.1";
 for await (const line of require("node:readline").createInterface({input:process.stdin})) {
   const request=JSON.parse(line);
   if(request.type==="control_request"){
     console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:request.request_id,response:{models:[]}}}));
     continue;
   }
   if(request.type!=="user") continue;
   const status=loopback ? (await fetch(base+"/v1/messages",{method:"POST",headers:{"x-api-key":env.ANTHROPIC_API_KEY},body:"{}"})).status : 200;
    fs.writeFileSync(${JSON.stringify(join(dir, "spawn.json"))}, JSON.stringify({loopback, hasAuth:!!env.ANTHROPIC_API_KEY, placeholder:env.ANTHROPIC_API_KEY==="sk-proxy-managed", retry:env.CLAUDE_CODE_MAX_RETRIES ?? null}));
   console.log(JSON.stringify({type:"result",subtype:"success",is_error:status!==200,api_error_status:status,result:status!==200 ? "Fixture inference failure":"Done",session_id:sid,uuid:crypto.randomUUID(),duration_ms:1,total_cost_usd:0,num_turns:1,usage:{input_tokens:1,output_tokens:1}}));
 }
})().catch(()=>process.exit(1));
`,
    { mode: 0o700 }
  );
  const codex = join(dir, "codex.cjs");
  await writeFile(
    codex,
    `#!${process.execPath}
const fs = require("node:fs");
const {createInterface}=require("node:readline");
if (process.argv.includes("--version")) { console.log("codex-cli 0.169.1"); process.exit(0); }
const save = (proof) => fs.writeFileSync(${JSON.stringify(join(dir, "codex-delivery.json"))}, JSON.stringify(proof));
createInterface({input:process.stdin}).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "account/login/start") {
    save({login: true});
    process.exit(0);
  }
  if (msg.method === "thread/start" || msg.method === "thread/resume") {
    const provider = msg.params.config.model_providers?.[msg.params.modelProvider];
    const loopback = !!provider && new URL(provider.base_url).hostname === "127.0.0.1";
    if (loopback) await fetch(provider.base_url + "/responses", {
      method: "POST", headers: {authorization: "Bearer " + provider.experimental_bearer_token}, body: "{}"
    });
    save({loopback, placeholder: provider?.experimental_bearer_token === "sk-proxy-managed",
      retries: [provider?.request_max_retries, provider?.stream_max_retries],
      originalHome: process.env.CODEX_HOME === ${JSON.stringify(dir)}});
    process.exit(0);
  }
  console.log(JSON.stringify({id:msg.id,result:msg.method === "config/read" ? {config:{}} : {}}));
});
`,
    { mode: 0o700 }
  );
  for (const [name, value] of Object.entries({
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CLI_PATH: cli,
    CODEX_CLI_PATH: codex,
    CODEX_HOME: dir,
  }))
    vi.stubEnv(name, value);
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_MAX_RETRIES",
    "DEUS_BUNDLED_BIN_DIR",
  ])
    vi.stubEnv(name, undefined);
  await service.init();
});
afterAll(() => service.shutdown());

it.each(["refused", "stopped"])(
  "a first send %s before admission leaves the same chat native",
  async (mode) => {
    const id = chat(),
      revision = await connectHere(),
      before = requests;
    if (mode === "stopped") {
      const apps = await import("../../../../src/services/integrations");
      const wait = Promise.withResolvers<Awaited<ReturnType<typeof apps.resolveTurnApps>>>();
      const pendingApps = vi.spyOn(apps, "resolveTurnApps").mockReturnValueOnce(wait.promise);
      try {
        const pending = expect(send(id, revision)).rejects.toThrow();
        await vi.waitFor(() => expect(holdingTurn(id)?.phase).toBe("preparing"));
        await stopSession({ sessionId: id });
        await pending;
      } finally {
        wait.resolve({ servers: {}, skipped: [] });
        pendingApps.mockRestore();
      }
    } else {
      await expect(
        sendMessage({
          sessionId: id,
          content: "local fixture",
          model: "missing",
          agentHarness: "claude-code",
          gatewayRevision: revision,
        })
      ).rejects.toThrow(/route/);
    }
    expect(stored(id)).toBeNull();
    expect(requests).toBe(before);
    await expectNativeOnly(id);
  },
  30000
);

it.each([401, 429, "unreachable"] as const)(
  "an admitted first %s stays on its gateway and a fresh native chat makes zero gateway requests",
  async (failure) => {
    const id = chat(),
      revision = await connectHere(),
      catalogReads = probes;
    inferenceStatus = failure;
    try {
      await send(id, revision);
      await vi.waitFor(() => expect(holdingTurn(id)).toBeUndefined(), { timeout: 15000 });
      expect(stored(id)).toBe(revision);
      expect(probes).toBe(catalogReads);
      expect(queuedMessages(id).paused).toBe(failure === 429 ? "limit" : null);
      await expect(send(id)).rejects.toThrow(/different provider/);
      await expectNativeOnly(chat());
      inferenceStatus = 200;
      const before = authorizedInference;
      await send(id, revision);
      await vi.waitFor(() => expect(authorizedInference).toBeGreaterThan(before), {
        timeout: 15000,
      });
    } finally {
      inferenceStatus = 200;
    }
  },
  30000
);

it("refreshes discovery after a modelUnavailable end and leaves successful admission independent of discovery", async () => {
  const id = chat(),
    revision = await connectHere(),
    before = probes;
  inferenceStatus = 404;
  try {
    await send(id, revision);
    await vi.waitFor(() => expect(holdingTurn(id)).toBeUndefined(), { timeout: 15000 });
    await vi.waitFor(() => expect(probes).toBe(before + 1));
    expect(stored(id)).toBe(revision);
  } finally {
    inferenceStatus = 200;
  }
}, 30000);

it("keeps a recorded native turn on its subscription even when its first echo and acknowledgement were lost", async () => {
  const id = chat(),
    revision = await connectHere();
  db.prepare(
    "INSERT INTO turns (session_id, turn_id, started_at, ended_at) VALUES (?, 'native', 1, 2)"
  ).run(id);
  const before = requests;
  await expect(send(id, revision)).rejects.toThrow("different provider");
  expect(requests).toBe(before);
  expect(stored(id)).toBeNull();
});

it("delivers a gateway Claude credential through the engine listener and caps only that child's retries", async () => {
  const id = chat(),
    revision = await connectHere();
  await rm(join(dir, "spawn.json"), { force: true });
  const before = authorizedInference;
  await send(id, revision);
  await vi.waitFor(
    async () =>
      expect(await spawned()).toEqual({
        loopback: true,
        hasAuth: true,
        placeholder: true,
        retry: "0",
      }),
    { timeout: 15000 }
  );
  expect(authorizedInference).toBeGreaterThan(before);
  expect(stored(id)).toContain(revision);
  await vi.waitFor(() => expect(holdingTurn(id)).toBeUndefined());
  await expect(send(id)).rejects.toThrow("different provider");
}, 30000);

it("gives Codex a loopback provider and placeholder through thread/start on its own home", async () => {
  const sessionId = chat(),
    revision = await connectHere(),
    before = authorizedInference;
  await sendMessage({
    sessionId,
    content: "local fixture",
    model: codexModel,
    agentHarness: "codex-app-server",
    gatewayRevision: revision,
  });
  await vi.waitFor(
    async () => {
      const proof = JSON.parse(await readFile(join(dir, "codex-delivery.json"), "utf8"));
      expect(proof).toEqual({
        loopback: true,
        placeholder: true,
        retries: [0, 0],
        originalHome: true,
      });
    },
    { timeout: 15000 }
  );
  expect(authorizedInference).toBe(before + 1);
}, 30000);

it("delivers the binding of the admitted chat to each harness", async () => {
  const revision = await connectHere();
  for (const [harness, format, id] of [
    ["codex-app-server", "responses", codexModel],
    ["claude-code", "messages", model],
  ] as const) {
    const sessionId = chat();
    const turnId = crypto.randomUUID();
    await sendMessage({
      sessionId,
      turnId,
      agentHarness: harness,
      model: id,
      gatewayRevision: revision,
      content: "fixture",
    });
    const source = vi.mocked(gatewayTurn.gatewayCredential);
    await vi.waitFor(async () => {
      const index = source.mock.calls.findIndex(
        ([request]) =>
          request.sessionId === sessionId && "turnId" in request && request.turnId === turnId
      );
      const credential = await source.mock.results[index]?.value;
      const revision = stored(sessionId);
      const connection = (await run(api.gateways)).find((g) => g.revision === revision);
      expect(connection).toBeDefined();
      expect(credential?.binding).toEqual({ ref: connection!.ref, revision, format });
    });
  }
}, 30000);

it("refuses the first credential handoff when its gateway was disconnected after admission", async () => {
  const sessionId = chat(),
    turnId = "first",
    revision = await connectHere();
  claimTurn(
    sessionId,
    turnId,
    undefined,
    undefined,
    await prepared("claude-code", { model, revision })
  );
  await run(api.disconnectGateway, { revision });
  await expect(gatewayCredential({ sessionId, turnId, harness: "claude-code" })).rejects.toThrow(
    /connection changed/
  );
});

it("renews only the current turn's credential and revision", async () => {
  const sessionId = chat(),
    revision = await connectHere();
  const turnId = "rekey",
    request = { sessionId, turnId, harness: "claude-code" as const };
  claimTurn(
    sessionId,
    turnId,
    undefined,
    undefined,
    await prepared("claude-code", { model, revision })
  );
  expect(
    (await gatewayCredential({ sessionId, harness: request.harness, purpose: "models" }))?.type
  ).toBeUndefined();
  const digest = createHash("sha256").update(key).digest("hex");
  await expect(gatewayCredential({ ...request, rejectedSha256: digest })).resolves.toMatchObject({
    type: "api_key",
    baseUrl,
  });
  await run(api.disconnectGateway, { revision });
  await expect(gatewayCredential({ ...request, rejectedSha256: digest })).rejects.toThrow(
    "connection changed"
  );
  await expect(gatewayCredential({ ...request, turnId: "stale" })).rejects.toThrow();
  forgetChatTurns(sessionId);
});

it("keeps a terminal bare 429 when an earlier error only reported the CLI exit", async () => {
  const sessionId = chat(),
    turnId = crypto.randomUUID(),
    revision = await connectHere();
  const gateway = await prepared("codex-app-server", { revision, model: codexModel });
  gatewayTurnEvent(
    {
      sessionId,
      seq: 1,
      event: {
        type: "error",
        sessionId,
        turnId,
        timestamp: 1,
        recoverable: false,
        category: "process_exit",
        message: "CLI exited",
      },
    },
    gateway
  );
  const error = { category: "rate_limit", message: "Limited" };
  const end = gatewayTurnEvent(
    {
      sessionId,
      seq: 2,
      event: { type: "turn.ended", sessionId, turnId, timestamp: 2, stopReason: "error", error },
    },
    gateway
  );
  expect(end.event).toMatchObject({ type: "turn.ended", error });
});

it("keeps the Bun catalog and each harness's credential-bearing relay requests on loopback", async () => {
  const script = fileURLToPath(new URL("../../../fixtures/gateway-loopback.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)("bun", ["--no-env-file", script], {
    timeout: 15000,
  });
  expect(JSON.parse(stdout)).toMatchObject({
    authorized: ["127.0.0.1", "[::1]"].flatMap((host) =>
      ["/v1/models", "/v1/messages", "/v1/responses"].map((path) => host + path)
    ),
    unexpectedProxyRequests: 0,
    proxyControl: 2,
  });
}, 20000);
