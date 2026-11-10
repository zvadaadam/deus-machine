// The vault on a Mac: its key is the Keychain's, asked for once at startup.
// The Keychain here is a stand-in that answers when the test says so.

import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "./fixtures";

type Answer = (error: unknown, value?: { stdout: string }) => void;

const state = vi.hoisted(() => ({ dir: "", reads: [] as Answer[] }));
vi.mock("../../../../src/lib/database", () => ({
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
}));

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
function sealedEarlier(value: unknown): string {
  process.env.DEUS_VAULT_KEY = KEYCHAIN_KEY;
  const sealed = seal(value);
  delete process.env.DEUS_VAULT_KEY;
  __resetVaultKeyForTests();
  return sealed;
}

beforeEach(() => {
  state.dir = scratchDir("deus-vault-keychain-");
  state.reads = [];
  delete process.env.DEUS_VAULT_KEY;
  delete process.env.DEUS_VAULT_NO_KEYCHAIN;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  __resetVaultKeyForTests();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("the vault while the Keychain is being asked", () => {
  it("makes up no key of its own, and uses the Keychain's once it answers", async () => {
    const saved = sealedEarlier({ token: "saved-sign-in" });
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
    const saved = sealedEarlier("kept");
    const starting = initVault();
    state.reads[0]!(Object.assign(new Error("timed out"), { code: null }));
    await starting;
    expect(vaultProblem()).toMatch(/Keychain is locked/);
    expect(() => seal("new")).toThrow(/Keychain is locked/);
    expect(open(saved)).toBeNull();
    expect(fs.existsSync(keyFile())).toBe(false);
  });
});
