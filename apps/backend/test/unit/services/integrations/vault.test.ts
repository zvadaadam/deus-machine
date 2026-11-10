import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "./fixtures";

const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../../src/lib/database", () => ({
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));

import {
  __resetVaultKeyForTests,
  initVault,
  open,
  seal,
} from "../../../../src/services/integrations/vault";

const keyFile = () => path.join(state.dir, "integrations.key");

beforeEach(() => {
  state.dir = scratchDir("deus-vault-");
  delete process.env.DEUS_VAULT_KEY;
  process.env.DEUS_VAULT_NO_KEYCHAIN = "1";
  __resetVaultKeyForTests();
});

afterEach(() => {
  delete process.env.DEUS_VAULT_NO_KEYCHAIN;
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("the vault", () => {
  it("seals so the stored form says nothing, and opens what it sealed", async () => {
    await initVault();
    const sealed = seal({ token: "sntrys_secret", nested: { n: 1 } });
    expect(sealed).not.toContain("sntrys_secret");
    expect(open(sealed)).toEqual({ token: "sntrys_secret", nested: { n: 1 } });
    // Each seal has its own nonce.
    expect(seal({ token: "sntrys_secret" })).not.toBe(seal({ token: "sntrys_secret" }));
  });

  it("keeps its key in a file only the user can read, and reuses it", async () => {
    await initVault();
    const sealed = seal("kept");
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    __resetVaultKeyForTests(); // a restart
    await initVault();
    expect(open(sealed)).toBe("kept");
  });

  it("a lost or changed key opens nothing instead of throwing", async () => {
    await initVault();
    const sealed = seal("gone");
    fs.rmSync(keyFile());
    __resetVaultKeyForTests();
    await initVault();
    expect(open(sealed)).toBeNull();
    expect(open("v1.not.a.real-value")).toBeNull();
    expect(open(null)).toBeNull();
  });

  it("a damaged value opens nothing", async () => {
    await initVault();
    const sealed = seal("intact");
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
    expect(open(tampered)).toBeNull();
  });

  it("DEUS_VAULT_KEY overrides the file", async () => {
    process.env.DEUS_VAULT_KEY = "ab".repeat(32);
    await initVault();
    const sealed = seal("env");
    expect(fs.existsSync(keyFile())).toBe(false);
    __resetVaultKeyForTests();
    process.env.DEUS_VAULT_KEY = "cd".repeat(32);
    expect(open(sealed)).toBeNull();
  });
});
