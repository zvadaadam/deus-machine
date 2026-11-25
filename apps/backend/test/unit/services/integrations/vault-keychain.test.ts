// The Keychain here answers when the test says so.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDatabase, scratchDir, testCatalog } from "./fixtures";

type Answer = (error: unknown, value?: { stdout: string }) => void;

const state = vi.hoisted(() => ({
  dir: "",
  db: null as Database.Database | null,
  reads: [] as Answer[],
  create: vi.fn(),
}));
vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  // `security find-generic-password`: held until the test answers it.
  execFile: (_file: string, _args: string[], _options: unknown, done: Answer) => {
    state.reads.push(done);
  },
  spawn: state.create,
}));
vi.mock("@shared/integrations/catalog", () => ({
  get CATALOG() {
    return testCatalog();
  },
}));
vi.mock("../../../../src/services/integrations/checks", () => ({ checkApp: vi.fn() }));

import { startIntegrations } from "../../../../src/services/integrations";
import { addCustomApp, connectApp, uninstallApp } from "../../../../src/services/integrations/apps";
import {
  createConnection,
  getInstallation,
  listConnections,
  readCredential,
} from "../../../../src/services/integrations/store";
import {
  __resetVaultKeyForTests,
  initVault,
  open,
  seal,
  vaultProblem,
} from "../../../../src/services/integrations/vault";

const KEYCHAIN_KEY = "ab".repeat(32);
const keyFile = () => path.join(state.dir, "integrations.key");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

/** What an earlier run sealed under the Keychain's key. */
async function sealedEarlier(value: unknown): Promise<string> {
  process.env.DEUS_VAULT_KEY = KEYCHAIN_KEY;
  await initVault();
  const sealed = seal(value);
  delete process.env.DEUS_VAULT_KEY;
  __resetVaultKeyForTests();
  return sealed;
}

beforeEach(() => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-vault-keychain-");
  state.reads = [];
  state.create.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    return Object.assign(child, {
      stdin: { end: () => queueMicrotask(() => child.emit("close", 0)) },
    });
  });
  delete process.env.DEUS_VAULT_KEY;
  delete process.env.DEUS_VAULT_NO_KEYCHAIN;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  __resetVaultKeyForTests();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  state.db?.close();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("a Mac's first app sign-in", () => {
  it("starts without asking the Keychain when there is no sealed credential", async () => {
    const starting = startIntegrations(4100);
    expect(state.reads).toHaveLength(0);
    await starting;
    await connectApp({ appId: "context7" });
    createConnection({ appId: "github", kind: "cli", status: "active" });
    await startIntegrations(4100);
    expect(state.reads).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("leaves a replacement custom server disconnected when a connect was waiting for the key", async () => {
    const custom = {
      name: "Notes",
      transport: { type: "http", url: "https://first.example.test/mcp" },
      auth: { kind: "bearer", label: "Key" },
    } as const;
    const { appId } = addCustomApp(custom);
    const connecting = connectApp({ appId, values: { token: "fixture" } });
    expect(state.reads).toHaveLength(1);
    uninstallApp(appId);
    expect(
      addCustomApp({
        ...custom,
        transport: { type: "http", url: "https://second.example.test/mcp" },
      })
    ).toEqual({ appId });
    state.reads[0]!(null, { stdout: KEYCHAIN_KEY });
    await expect(connecting).rejects.toThrow(/changed/i);
    expect(getInstallation("app", appId)?.connectionId).toBeNull();
    expect(listConnections(appId)).toHaveLength(0);
  });

  it.each([
    ["one app connects", [{ appId: "sentry", values: { token: "fixture" } }]],
    [
      "two apps connect at once",
      [
        { appId: "sentry", values: { token: "fixture" } },
        { appId: "exa", values: { EXA_API_KEY: "fixture" } },
      ],
    ],
  ] as const)("creates exactly one key when %s", async (_name, inputs) => {
    const connecting = Promise.all(inputs.map(connectApp));
    expect(state.reads).toHaveLength(1);
    expect(listConnections()).toHaveLength(0);
    state.reads[0]!({ code: 44 });
    await vi.waitFor(() => expect(state.reads).toHaveLength(2));
    state.reads[1]!(null, { stdout: KEYCHAIN_KEY });
    await connecting;
    expect(state.create).toHaveBeenCalledExactlyOnceWith("security", ["-i"], expect.anything());
    for (const input of inputs) {
      const [row] = listConnections(input.appId);
      expect(readCredential(row!.id)).toEqual({ values: input.values });
    }
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("opens an earlier credential at startup and shares its key with a connect arriving then", async () => {
    const saved = await sealedEarlier({ values: { token: "earlier" } });
    state
      .db!.prepare(
        "INSERT INTO integration_connections (id, app_id, kind, credential) VALUES ('old', 'github', 'secret', ?)"
      )
      .run(saved);
    const starting = startIntegrations(4100);
    const connecting = connectApp({ appId: "sentry", values: { token: "fixture" } });
    expect(state.reads).toHaveLength(1);
    expect(readCredential("old")).toBeNull();
    state.reads[0]!(null, { stdout: KEYCHAIN_KEY });
    await Promise.all([starting, connecting]);
    expect(readCredential("old")).toEqual({ values: { token: "earlier" } });
    expect(state.reads).toHaveLength(1);
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe("the vault while the Keychain is being asked", () => {
  it("makes up no key of its own, and uses the Keychain's once it answers", async () => {
    const saved = await sealedEarlier({ token: "saved-sign-in" });
    const starting = initVault();
    expect(state.reads).toHaveLength(1);

    // A request that arrives first is refused, not served with a new key.
    expect(vaultProblem()).toMatch(/still loading/);
    expect(() => seal({ token: "new" })).toThrow(/still loading/);
    expect(open(saved)).toBeNull();
    expect(fs.existsSync(keyFile())).toBe(false);

    state.reads[0]!(null, { stdout: `${KEYCHAIN_KEY}\n` });
    await starting;
    expect(vaultProblem()).toBeNull();
    expect(open(saved)).toEqual({ token: "saved-sign-in" });
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("stays shut when the Keychain does not answer", async () => {
    const saved = await sealedEarlier("kept");
    const starting = initVault();
    state.reads[0]!(Object.assign(new Error("timed out"), { code: null }));
    await starting;
    expect(vaultProblem()).toMatch(/Keychain is locked/);
    expect(() => seal("new")).toThrow(/Keychain is locked/);
    expect(open(saved)).toBeNull();
    expect(fs.existsSync(keyFile())).toBe(false);
  });
});
