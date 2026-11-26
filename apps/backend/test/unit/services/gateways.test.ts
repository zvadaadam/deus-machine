import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { gatewaySupports } from "@shared/gateways";
import { SCHEMA_SQL } from "@shared/schema";
import { LOCAL_CALLER } from "../../../src/api/registry";
import gatewayHandlers from "../../../src/api/gateways";
import { GatewayError, ValidationError } from "../../../src/lib/errors";
import * as gatewayTurn from "../../../src/services/gateways/turn";
import { claimTurn, holdingTurn, forgetChatTurns } from "../../../src/services/agent/chat-turn";
import * as service from "../../../src/services/agent/service";
import { queuedMessages } from "../../../src/services/agent/queue";
import { sendMessage, stopSession } from "../../../src/services/agent/turns";
import {
  prepareGatewayTurn,
  gatewayCredential,
  gatewayTurnEvent,
} from "../../../src/services/gateways/turn";
import { checkCatalog } from "../../../src/services/gateways/catalog";
import { getAllSettings } from "../../../src/services/settings.service";
import { operations, assistantCaller } from "../../helpers";

vi.mock("../../../src/services/gateways/turn", async (load) => {
  const original = await load<typeof gatewayTurn>();
  return { ...original, gatewayCredential: vi.fn(original.gatewayCredential) };
});

let db: Database.Database;
let dir: string;
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => db,
  get DB_PATH() {
    return join(dir, "deus.db");
  },
}));
vi.mock("../../../src/services/integrations", () => ({
  resolveTurnApps: async () => ({ servers: {}, skipped: [] }),
}));
vi.mock("../../../../agent-server/agents/environment", () => ({
  applyShellEnvironment() {},
  getShellEnvironment: () => ({}),
}));
vi.mock("../../../src/services/pr-snapshot.service", () => ({ refreshPrSnapshotForSession() {} }));
const run = operations(gatewayHandlers);
const key = randomBytes(24).toString("hex");
const model = "custom:model";
const codexModel = "gpt-6.2-astra";
let baseUrl: string;
let inferenceStatus: number | "unreachable" = 200;
let probes = 0;
let requests = 0;
let authorizedInference = 0;
const gateway = createServer((req, res) => {
  requests++;
  if (req.url === "/v1/models") {
    probes++;
    res.writeHead(req.headers.authorization === "Bearer " + key ? 200 : 401);
    res.end(
      JSON.stringify({
        data: [
          {
            id: model,
            owned_by: "   ",
            supported_endpoints: ["messages"],
            output_modalities: ["text"],
            supported_parameters: ["tools"],
          },
          { id: codexModel, owned_by: "openai" },
        ],
      })
    );
  } else {
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
  }
});
const chat = () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (id,workspace_id) VALUES (?, 'w')").run(id);
  return id;
};
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

async function prepared(
  harness: "claude-code" | "codex-app-server",
  pick: {
    revision: string;
    model: string;
    thinkingLevel?: Parameters<typeof prepareGatewayTurn>[1];
  }
) {
  const { requireRevision } = await import("../../../src/services/gateways/connections");
  const ref = requireRevision(pick.revision).ref;
  const turn: Parameters<typeof prepareGatewayTurn>[0] = {
    binding: {
      ref,
      revision: pick.revision,
      format: harness === "claude-code" ? "messages" : "responses",
    },
    execution: { model: pick.model, harness },
  };
  await prepareGatewayTurn(turn, pick.thinkingLevel);
  return turn;
}

async function connectHere() {
  await run(api.connectGateway, {
    preset: "cliproxyapi",
    baseUrl,
    apiKey: key,
    revision: null,
  });
  return (await run(api.gateways))[0]!.revision;
}

function mockCatalogRead(base: string) {
  const { fetch } = globalThis;
  const read = vi.fn<() => Promise<Response>>();
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
    String(url) === base + "/v1/models" ? read() : fetch(url, init)
  );
  return read;
}

afterEach(async () => {
  for (const { revision } of await run(api.gateways))
    await run(api.disconnectGateway, { revision });
});

beforeAll(async () => {
  const dataDir = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : tmpdir();
  dir = await mkdtemp(join(dataDir, "deus-gateway-test-"));
  await mkdir(join(dir, ".deus", "work"), { recursive: true });
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id,name,root_path) VALUES ('r','Test',?)").run(dir);
  db.exec("INSERT INTO workspaces (id,repository_id,slug,state) VALUES ('w','r','work','ready')");
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
    HOME: dir,
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CLI_PATH: cli,
    CODEX_CLI_PATH: codex,
    CODEX_HOME: dir,
    DEUS_VAULT_NO_KEYCHAIN: "1",
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
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const bound = gateway.address();
  if (!bound || typeof bound === "string") throw Error("missing test listener");
  baseUrl = "http://127.0.0.1:" + bound.port;
  await service.init();
});

afterAll(async () => {
  await service.shutdown();
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  vi.unstubAllEnvs();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

it("accepts a loopback gateway with a fresh identity and keeps the key out of reads", async () => {
  const input = { preset: "cliproxyapi" as const, baseUrl, apiKey: key, revision: null };
  const loopback = "Use a loopback address on 127.0.0.1, localhost or [::1].";
  for (const [bad, reason] of [
    ["http://127.1", loopback],
    ["http://localhost@localhost", "Enter the API key in its own field."],
    ["http://localhost/f", loopback],
    ["http://10.0.0.2", loopback],
  ] as const)
    await expect(run(api.connectGateway, { ...input, baseUrl: bad })).rejects.toThrow(reason);
  const beforeReads = probes;
  await expect(run(api.connectGateway, { ...input, apiKey: "refused" })).rejects.toThrow(
    "rejected the API key"
  );
  expect(await run(api.gateways)).toEqual([]);
  await run(api.connectGateway, input);
  expect(probes).toBe(beforeReads + 2);
  const [status] = await run(api.gateways);
  expect(status?.ref).toMatch(/^[0-9a-f-]{36}$/);
  expect(status?.models).toContainEqual({
    id: model,
    provider: "",
    label: model,
    runner: "claude-code",
  });
  expect(JSON.stringify(status)).not.toContain(key);
  expect(getAllSettings()).not.toHaveProperty("gateways");
  expect((await readFile(join(dir, "preferences.json"), "utf8")).includes(key)).toBe(false);
});

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

it.each(["refused", "stopped"])(
  "a first send %s before admission leaves the same chat native",
  async (mode) => {
    const id = chat(),
      revision = await connectHere(),
      before = requests;
    if (mode === "stopped") {
      const apps = await import("../../../src/services/integrations");
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

it.each(["%73ynthetic-fixture", "bad%", "%FF"])(
  "rejects a Custom address containing an encoded key or malformed escape (%s)",
  async (path) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network request"));
    try {
      await expect(
        run(api.connectGateway, {
          preset: "custom",
          baseUrl: "https://fixture.invalid/" + path,
          apiKey: "synthetic-fixture",
          revision: null,
          formats: ["responses"],
        })
      ).rejects.toThrow(ValidationError);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  }
);

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

it("reports a rejected API key even when cancelling the 401 response body fails", async () => {
  const body = new ReadableStream({ cancel: () => Promise.reject(new Error("stream closed")) });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(body, { status: 401 }));
  try {
    await expect(
      checkCatalog({ preset: "cliproxyapi", baseUrl, apiKey: key, formats: ["messages"] })
    ).rejects.toMatchObject({
      constructor: GatewayError,
      message: "CLIProxyAPI rejected the API key.",
      details: { kind: "api_key" },
    });
  } finally {
    fetcher.mockRestore();
  }
});

it.each(["openrouter", "custom"] as const)(
  "uses only observed HTTP responses to diagnose %s",
  async (preset) => {
    const diagnostic =
      "HTTP 429, unknown provider for model, all accounts cooling (reset after 2m): ";
    const connection = {
      preset,
      baseUrl: "https://gateway.example/api",
      apiKey: key,
      formats: ["messages"] as const,
    };
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      for (const [status, kind] of [
        [403, "api_key"],
        [429, "catalog"],
        [502, "catalog"],
      ] as const) {
        fetcher.mockResolvedValueOnce(
          new Response(diagnostic + key, {
            status,
            headers: { "Retry-After": "Tue, 24 Nov 2026 12:00:00 GMT" },
          })
        );
        await expect(checkCatalog(connection)).rejects.toMatchObject({
          details: { kind },
        });
      }
    } finally {
      fetcher.mockRestore();
    }
  }
);

it("joins published ids to the pinned client catalog, leaves unknowns in Settings and fits the runner's effort", async () => {
  const { DEFAULT_PINS } = await import("@zvada/agent-server/core");
  const publicRows = [
    { id: "gpt-6.2-astra", owned_by: "openai" },
    { id: "claude-sonnet-4-6", owned_by: "anthropic" },
    { id: "gpt-image-2", owned_by: "openai" },
    { id: "gpt-lookalike", owned_by: "openai" },
    {
      id: "vendor:vision",
      owned_by: "vendor",
      supported_endpoints: ["responses"],
      output_modalities: ["text"],
      supported_parameters: ["tools"],
    },
    {
      id: "vendor:audio",
      owned_by: "vendor",
      supported_endpoints: ["responses"],
      output_modalities: ["audio"],
      supported_parameters: ["tools"],
    },
  ];
  const rich = publicRows.map(({ id }) => ({
    slug: id,
    display_name: id === "gpt-6.2-astra" ? "GPT 6.2 Astra" : id,
    visibility: id === "gpt-image-2" ? "hide" : "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: ["medium", "high", "fictional"].map((effort) => ({ effort })),
  }));
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = new URL(String(url));
    return Response.json(
      u.searchParams.get("client_version") === DEFAULT_PINS.codex
        ? { models: [...rich, { slug: "not-published", visibility: "list" }] }
        : { data: [...publicRows, publicRows[0]] }
    );
  });
  try {
    const revision = await connectHere();
    const models = (await run(api.gateways))[0]!.models;
    expect(models).toHaveLength(6);
    expect(models[0]).toMatchObject({
      label: "GPT 6.2 Astra",
      runner: "codex-app-server",
      thinkingByFormat: { responses: { levels: ["medium", "high"], default: "medium" } },
    });
    expect(models[1]).toMatchObject({ label: "Sonnet 4.6", runner: "claude-code" });
    expect(models[2]).toMatchObject({ excluded: "hidden" });
    expect(models[3]?.runner).toBeUndefined();
    expect(models[4]?.runner).toBe("codex-app-server");
    expect(models[5]?.runner).toBeUndefined();
    await expect(
      prepared("claude-code", {
        revision,
        model: "gpt-6.2-astra",
      })
    ).rejects.toThrow();
    await expect(
      prepared("codex-app-server", {
        revision,
        model: "gpt-lookalike",
      })
    ).rejects.toThrow();
    expect(
      (
        await prepared("codex-app-server", {
          revision,
          model: "gpt-6.2-astra",
          thinkingLevel: "ultra",
        })
      ).thinkingLevel
    ).toBe("medium");
    expect(
      (
        await prepared("codex-app-server", {
          revision,
          model: "vendor:vision",
          thinkingLevel: "high",
        })
      ).thinkingLevel
    ).toBeUndefined();
  } finally {
    fetcher.mockRestore();
  }
});

it.each([
  ["openrouter", "https://other.example/api", /official/],
  ["custom", "http://remote.example/api", /HTTPS/],
  ["cliproxyapi", "https://remote.example", /loopback/],
] as const)(
  "validates a previously sealed %s destination before delivering a key",
  async (preset, baseUrl, error) => {
    const { initVault, seal } = await import("../../../src/services/integrations/vault");
    const { saveSetting } = await import("../../../src/services/settings.service");
    const { connectionFor } = await import("../../../src/services/gateways/connections");
    await initVault("seal");
    const credential = seal({ baseUrl, apiKey: key, formats: ["responses"], models: [] });
    const revision = crypto.randomUUID();
    saveSetting("gateways", [{ ref: crypto.randomUUID(), revision, preset, credential }]);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No outbound requests"));
    try {
      await expect(connectionFor(revision)).rejects.toThrow(error);
      await expect(run(api.refreshGateway, { revision })).rejects.toThrow(error);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  }
);

it("seals independent gateways, validates the OpenRouter key, and binds the requested format, model and revision", async () => {
  const { connectionFor } = await import("../../../src/services/gateways/connections");
  const requests: string[] = [];
  const customKey = randomBytes(24).toString("hex");
  const fixture = {
    data: [
      {
        id: "openai/example",
        name: "Example GPT",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        endpoints: ["/api/v1/responses", "/api/v1/messages"],
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["low", "high", "unsupported"], default_effort: "high" },
      },
      {
        id: "anthropic/example",
        name: "Example Claude",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        endpoints: ["/api/v1/messages"],
        supported_parameters: ["tools"],
      },
      {
        id: "example/image",
        name: "Image",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        supported_parameters: ["tools"],
      },
      {
        id: "example/input",
        architecture: { input_modalities: ["image"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
      },
      {
        id: "example/plain",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: [],
      },
      {
        id: "example/chat-only",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
        endpoints: ["/v1/chat/completions"],
      },
    ],
  };
  const { fetch: realFetch } = globalThis;
  let rejectSavedKey = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    requests.push(url.pathname + url.search);
    if (url.hostname === "gateway.example")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + customKey);
    expect(init?.redirect).toBe("manual");
    const accepted = new Headers(init?.headers).get("authorization") === "Bearer " + key;
    if (url.pathname.endsWith("/key"))
      return Response.json(
        { data: { label: "fixture" } },
        { status: accepted && !rejectSavedKey ? 200 : 401 }
      );
    if (!url.pathname.endsWith("/models")) return new Response(null, { status: 404 });
    return Response.json(fixture);
  });
  const managed = {
    preset: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    revision: null,
    apiKey: key,
  };
  try {
    const original = await connectHere();
    await expect(run(api.connectGateway, { ...managed, apiKey: "rejected" })).rejects.toThrow(
      /key/i
    );
    fetch.mockResolvedValueOnce(new Response("Public landing page"));
    await expect(run(api.connectGateway, managed)).rejects.toThrow(/verify|key/i);
    const privateKey = {
      ...managed,
      preset: "custom" as const,
      baseUrl: "https://gateway.example/team/v1",
      apiKey: customKey,
      formats: ["responses" as const],
    };
    await expect(run(api.connectGateway, { ...privateKey, formats: [] })).rejects.toThrow();
    await Promise.all([run(api.connectGateway, managed), run(api.connectGateway, privateKey)]);
    const all = await run(api.gateways);
    expect(all).toHaveLength(3);
    for (const secret of [key, customKey]) expect(JSON.stringify(all)).not.toContain(secret);
    expect(getAllSettings()).not.toHaveProperty("gateways");
    expect((await readFile(join(dir, "preferences.json"), "utf8")).includes(key)).toBe(false);
    const router = all.find((g) => g.preset === "openrouter")!;
    const custom = all.find((g) => g.preset === "custom")!;
    expect(router.models.map((m) => m.runner)).toEqual([
      "codex-app-server",
      "claude-code",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(custom.models.map((m) => m.id)).toEqual(fixture.data.map((m) => m.id));
    expect(router.models[0]).toMatchObject({
      label: "Example GPT",
      provider: "openai",
      thinkingByFormat: { responses: { levels: ["low", "high"], default: "high" } },
    });
    expect(requests).toContain("/api/v1/key");
    expect(requests).toContain("/api/v1/models");
    expect(requests).toContain("/team/v1/models");
    expect(requests.some((p) => p.includes("client_version"))).toBe(false);
    rejectSavedKey = true;
    await expect(
      run(api.connectGateway, { ...managed, revision: router.revision, apiKey: undefined })
    ).rejects.toThrow("rejected the API key");
    rejectSavedKey = false;
    await expect(
      run(api.connectGateway, {
        ...privateKey,
        baseUrl: "https://elsewhere.example",
        revision: custom.revision,
        apiKey: undefined,
      })
    ).rejects.toThrow(/key/i);
    expect((await connectionFor(custom.revision)).apiKey).toBe(customKey);
    const sid = chat(),
      tid = crypto.randomUUID();
    const turn = await prepared("claude-code", {
      revision: router.revision,
      model: "anthropic/example",
    });
    claimTurn(sid, tid, undefined, undefined, turn);
    try {
      expect(turn.execution.via).toBe("OpenRouter");
      expect(
        await gatewayCredential({ sessionId: sid, turnId: tid, harness: "claude-code" })
      ).toMatchObject({ type: "api_key", apiKey: key, baseUrl: "https://openrouter.ai/api" });
      const codex = await prepared("codex-app-server", {
        revision: custom.revision,
        model: "openai/example",
      });
      const secondId = chat();
      claimTurn(secondId, tid, undefined, undefined, codex);
      const credential = await gatewayCredential({
        sessionId: secondId,
        turnId: tid,
        harness: "codex-app-server",
      });
      expect(credential).toMatchObject({
        baseUrl: "https://gateway.example/team/v1",
        binding: { ref: custom.ref, revision: custom.revision, format: "responses" },
      });
      await expect(
        prepared("claude-code", {
          revision: custom.revision,
          model: "anthropic/example",
        })
      ).rejects.toThrow(/route/i);
      await run(api.connectGateway, {
        ...privateKey,
        formats: ["messages"],
        revision: custom.revision,
        apiKey: undefined,
      });
      await expect(connectionFor(custom.revision)).rejects.toThrow(/changed/i);
      expect((await run(api.gateways)).find((g) => g.ref === custom.ref)?.revision).not.toBe(
        custom.revision
      );
      expect((await connectionFor(original)).baseUrl).toBe(baseUrl);
      expect((await connectionFor(router.revision)).apiKey).toBe(key);
    } finally {
      forgetChatTurns(sid);
    }
  } finally {
    fetch.mockRestore();
  }
});

it("validates a gateway destination and a request from this computer before touching the network", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("unexpected network"));
  try {
    const input = {
      preset: "custom" as const,
      baseUrl: "https://gateway.example/api",
      formats: ["messages" as const],
      apiKey: key,
      revision: null,
    };
    for (const caller of [
      { ...LOCAL_CALLER, relayed: true },
      { ...LOCAL_CALLER, deviceId: "paired" },
      assistantCaller(),
    ]) {
      const remote = operations(gatewayHandlers, caller);
      await expect(remote(api.connectGateway, input)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        remote(api.disconnectGateway, { revision: crypto.randomUUID() })
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    for (const baseUrl of [
      "http://example.org",
      "http://127.1",
      "http://localhost.example",
      "https://user:pass@gateway.example",
      "https://gateway.example?token=secret",
      "https://gateway.example/#frag",
      "file:///tmp/key",
    ])
      await expect(run(api.connectGateway, { ...input, baseUrl })).rejects.toThrow();
    await expect(
      run(api.connectGateway, {
        ...input,
        preset: "cliproxyapi",
        baseUrl: "https://gateway.example",
      })
    ).rejects.toThrow();
    await expect(
      run(api.connectGateway, { ...input, preset: "openrouter", baseUrl: "http://localhost" })
    ).rejects.toThrow();
    await expect(run(api.connectGateway, { ...input, preset: "openrouter" })).rejects.toThrow(
      /OpenRouter/
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("uses published capabilities for OpenRouter even when an id is in the harness catalog", async () => {
  const fixture = {
    id: "openai/gpt-6.2-astra",
    name: "Catalog example",
    endpoints: ["/api/v1/responses"],
    reasoning: { supported_efforts: ["low", "high"] },
  };
  const rows = [
    fixture,
    {
      ...fixture,
      id: "openai/fixed",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
  ];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      Response.json(String(url).endsWith("/key") ? { data: { label: "fixture" } } : { data: rows })
    );
  try {
    await run(api.connectGateway, {
      preset: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      apiKey: key,
      revision: null,
    });
    const [router] = await run(api.gateways);
    expect(router!.models[0]?.runner).toBeUndefined();
    expect(router!.models[1]?.runner).toBe("codex-app-server");
    expect(router!.models[1]?.thinkingByFormat).toBeUndefined();
  } finally {
    fetch.mockRestore();
  }
});

it("lets this computer replace an unreadable saved key without reusing its revision", async () => {
  const { saveSetting } = await import("../../../src/services/settings.service");
  const revision = crypto.randomUUID();
  const ref = crypto.randomUUID();
  saveSetting("gateways", [{ ref, preset: "cliproxyapi", revision, credential: "unreadable" }]);
  expect((await run(api.gateways))[0]?.problem).toBeDefined();
  await expect(
    run(api.connectGateway, { preset: "cliproxyapi", baseUrl, revision })
  ).rejects.toThrow();
  await run(api.connectGateway, { preset: "cliproxyapi", baseUrl, apiKey: key, revision });
  const [restored] = await run(api.gateways);
  expect(restored).toMatchObject({ ref, preset: "cliproxyapi", baseUrl });
  expect(restored?.revision).not.toBe(revision);
  expect(restored?.problem).toBeUndefined();
});

it("has no account inventory or management key on the wire", () => {
  for (const name of ["gatewayAccounts", "gatewayOfferings", "setGatewayManagementKey"])
    expect(api).not.toHaveProperty(name);
});

it("keeps the canonical Custom path and honors explicit catalog restrictions in the picker and admission", async () => {
  const { connectionFor } = await import("../../../src/services/gateways/connections");
  const data = [
    { id: "unknown-id" },
    { id: "unspecified", supported_endpoints: null, supported_parameters: null },
    { id: "one-endpoint", endpoints: ["/api/v1/messages"] },
    { id: "other-endpoint", supported_endpoints: ["responses"] },
    { id: "embeddings", endpoints: ["/v1/embeddings"] },
    { id: "empty-list", endpoints: [] },
    { id: "hidden", visibility: "hide" },
    { id: "audio", output_modalities: ["audio"] },
    { id: "no-tools", supported_parameters: [] },
  ];
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ data }));
  try {
    await run(api.connectGateway, {
      preset: "custom",
      baseUrl: baseUrl + "/nested/v1/v1/",
      formats: ["messages", "responses"],
      apiKey: key,
      revision: null,
    });
    const gateway = (await run(api.gateways))[0]!;
    expect((await connectionFor(gateway.revision)).baseUrl).toBe(baseUrl + "/nested/v1");
    expect(gateway.models.map((m) => m.id)).toEqual(data.map((m) => m.id));
    for (const harness of ["claude-code", "codex-app-server"] as const) {
      const eligible = [
        "unknown-id",
        "unspecified",
        harness === "claude-code" ? "one-endpoint" : "other-endpoint",
      ];
      expect(
        gateway.models.filter((m) => gatewaySupports(gateway, m, harness)).map((m) => m.id)
      ).toEqual(eligible);
      for (const { id } of data) {
        const turn = prepared(harness, { revision: gateway.revision, model: id });
        if (eligible.includes(id))
          await expect(turn).resolves.toMatchObject({ execution: { model: id, harness } });
        else await expect(turn).rejects.toThrow(/no chat route/);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
  }
});

it("shares a pending gateway catalog refresh and reads again after failure or success", async () => {
  await run(api.connectGateway, {
    preset: "custom",
    baseUrl,
    apiKey: key,
    formats: ["responses"],
    revision: null,
  });
  const { revision } = (await run(api.gateways))[0]!;
  const waiting = Promise.withResolvers<void>();
  const fetcher = mockCatalogRead(baseUrl).mockImplementation(async () => {
    await waiting.promise;
    return new Response(null, { status: 503 });
  });
  const refresh = () => run(api.refreshGateway, { revision });
  const readers = Promise.allSettled([
    refresh(),
    refresh(),
    run(api.connectGateway, { preset: "custom", baseUrl, revision }),
  ]);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  } finally {
    waiting.resolve();
  }
  expect((await readers).map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await run(api.gateways))[0]?.problem?.kind).toBe("catalog");
  fetcher.mockImplementation(async () => Response.json({ data: [{ id: "new" }] }));
  await Promise.all([refresh(), refresh()]);
  expect((await run(api.gateways))[0]).toMatchObject({
    models: [{ id: "new" }],
    problem: undefined,
  });
  await refresh();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("refreshes an edited gateway while its previous revision still has a read in flight", async () => {
  const input = {
    preset: "custom" as const,
    baseUrl,
    apiKey: key,
    formats: ["responses" as const],
    revision: null,
  };
  await run(api.connectGateway, input);
  const old = (await run(api.gateways))[0]!;
  const waiting = Promise.withResolvers<void>();
  const fetcher = mockCatalogRead(baseUrl).mockImplementation(async () =>
    Response.json({ data: [{ id: "current" }] })
  );
  fetcher.mockImplementationOnce(async () => {
    await waiting.promise;
    return Response.json({ data: [{ id: "old" }] });
  });
  const oldRead = run(api.refreshGateway, { revision: old.revision });
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await run(api.connectGateway, {
      ...input,
      revision: old.revision,
      apiKey: randomBytes(24).toString("hex"),
    });
    const current = (await run(api.gateways))[0]!;
    expect(current.ref).toBe(old.ref);
    expect(current.revision).not.toBe(old.revision);
    await run(api.refreshGateway, { revision: current.revision });
  } finally {
    waiting.resolve();
  }
  await expect(oldRead).rejects.toThrow("connection changed");
  expect((await run(api.gateways))[0]?.models.map((m) => m.id)).toEqual(["current"]);
});

it.each([
  {
    name: "a known OpenRouter model",
    preset: "openrouter",
    endpoints: ["responses", "messages"],
    levels: ["high", "ultra"],
    expected: { responses: { levels: ["high"] } },
  },
  {
    name: "both Custom formats",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["high", "ultra"],
    expected: {
      messages: { levels: ["high"] },
      responses: { levels: ["high", "ultra"], default: "ultra" },
    },
  },
  {
    name: "one Custom format",
    preset: "custom",
    endpoints: ["responses"],
    levels: ["ultra"],
    expected: { responses: { levels: ["ultra"], default: "ultra" } },
  },
  {
    name: "two formats with efforts only Codex accepts",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["ultra"],
    expected: { responses: { levels: ["ultra"], default: "ultra" } },
  },
  {
    name: "no supported efforts",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["off"],
    expected: undefined,
  },
] as const)(
  "fits advertised efforts once for $name",
  async ({ preset, endpoints, levels, expected }) => {
    const row = {
      id: "openai/gpt-6-luna",
      endpoints,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: levels, default_effort: "ultra" },
    };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: [row] }));
    try {
      const [model] = await checkCatalog({
        preset,
        baseUrl,
        apiKey: key,
        formats: ["messages", "responses"],
      });
      expect(model).toBeDefined();
      if (expected) expect(model!.thinkingByFormat).toStrictEqual(expected);
      else expect(model).not.toHaveProperty("thinkingByFormat");
    } finally {
      fetcher.mockRestore();
    }
  }
);

it("reopens the sealed Custom catalog with each runner's fitted efforts", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      data: [
        {
          id: "both",
          reasoning: { supported_efforts: ["high", "ultra"], default_effort: "ultra" },
        },
      ],
    })
  );
  try {
    await run(api.connectGateway, {
      preset: "custom",
      baseUrl,
      apiKey: key,
      revision: null,
      formats: ["messages", "responses"],
    });
    const [saved] = await run(api.gateways);
    const expected = {
      messages: { levels: ["high"] },
      responses: { levels: ["high", "ultra"], default: "ultra" },
    };
    expect(saved!.models[0]!.thinkingByFormat).toStrictEqual(expected);
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "--no-env-file",
        "-e",
        "const {connectionFor}=await import(process.argv[1]); const {models}=await connectionFor(process.argv[2]); console.log(JSON.stringify(models[0].thinkingByFormat));",
        new URL("../../../src/services/gateways/connections.ts", import.meta.url).href,
        saved!.revision,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, DATABASE_PATH: join(dir, "deus.db") },
      }
    );
    expect(JSON.parse(stdout)).toStrictEqual(expected);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    fetcher.mockRestore();
  }
});

it("keeps the Bun catalog and each harness's credential-bearing relay requests on loopback", async () => {
  const script = fileURLToPath(new URL("../../fixtures/gateway-loopback.mjs", import.meta.url));
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
