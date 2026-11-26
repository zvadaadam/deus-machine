import { randomBytes } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { api } from "@shared/api";
import { SCHEMA_SQL } from "@shared/schema";
import gatewayHandlers from "../../../../src/api/gateways";
import { prepareGatewayTurn } from "../../../../src/services/gateways/turn";
import { operations } from "../../../helpers";

// Import this fixture before backend services so they share the isolated database.
export let db: Database.Database;
export let dir: string;
vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => db,
  get DB_PATH() {
    return join(dir, "deus.db");
  },
}));

export const run = operations(gatewayHandlers);
export const key = randomBytes(24).toString("hex");
export const model = "custom:model";
export const codexModel = "gpt-6.2-astra";
export let baseUrl: string;

export let probes = 0;
export let requests = 0;

export function useGatewayFixture(inference?: RequestListener) {
  const gateway = createServer((req, res) => {
    requests++;
    if (req.url !== "/v1/models") {
      if (inference) inference(req, res);
      else res.end("{}");
      return;
    }
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
  });

  beforeAll(async () => {
    const dataDir = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : tmpdir();
    dir = await mkdtemp(join(dataDir, "deus-gateway-test-"));
    await mkdir(join(dir, ".deus", "work"), { recursive: true });
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO repositories (id,name,root_path) VALUES ('r','Test',?)").run(dir);
    db.exec("INSERT INTO workspaces (id,repository_id,slug,state) VALUES ('w','r','work','ready')");
    vi.stubEnv("HOME", dir);
    vi.stubEnv("DEUS_VAULT_NO_KEYCHAIN", "1");
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const bound = gateway.address();
    if (!bound || typeof bound === "string") throw Error("missing test listener");
    baseUrl = "http://127.0.0.1:" + bound.port;
  });
  afterEach(async () => {
    for (const { revision } of await run(api.gateways))
      await run(api.disconnectGateway, { revision });
  });

  afterAll(async () => {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    vi.unstubAllEnvs();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
}

export const chat = () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (id,workspace_id) VALUES (?, 'w')").run(id);
  return id;
};

export async function prepared(
  harness: "claude-code" | "codex-app-server",
  pick: {
    revision: string;
    model: string;
    thinkingLevel?: Parameters<typeof prepareGatewayTurn>[1];
  }
) {
  const { requireRevision } = await import("../../../../src/services/gateways/connections");
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

export async function connectHere() {
  await run(api.connectGateway, {
    preset: "cliproxyapi",
    baseUrl,
    apiKey: key,
    revision: null,
  });
  return (await run(api.gateways))[0]!.revision;
}
