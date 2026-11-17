import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected app path: ${name}`);
      return electronMocks.userDataDir;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("not encrypted by this device");
      return raw.slice(4);
    },
  },
}));

import {
  deleteAllOrgKeys,
  deleteOrgKey,
  getCloudCredentialsStatus,
  getOrgKey,
  getOrgKeys,
  listOrgKeys,
  orderOrgKeys,
  setOrgKey,
} from "../../../apps/desktop/main/cloud-credentials";
import * as credentialFile from "../../../apps/desktop/main/safe-storage-file";

const CREDENTIALS_FILE = () => join(electronMocks.userDataDir, "deus-cloud-credentials.json");
const encrypted = (value: string) => Buffer.from(`enc:${value}`, "utf8").toString("base64");

beforeEach(async () => {
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-creds-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(electronMocks.userDataDir, { recursive: true, force: true });
});

describe("cloud credential store", () => {
  it("round-trips a key per organization and never writes one in plaintext", async () => {
    await setOrgKey("org_a", "agnt_sk_live_a", { keyId: "key_1", label: "deus-desktop test" });
    await setOrgKey("org_b", "agnt_sk_live_b", { keyId: "key_2" });

    expect(await getOrgKey("org_a")).toBe("agnt_sk_live_a");
    expect(await getOrgKey("org_b")).toBe("agnt_sk_live_b");
    expect(await getOrgKeys()).toEqual({ org_a: "agnt_sk_live_a", org_b: "agnt_sk_live_b" });

    const raw = await readFile(CREDENTIALS_FILE(), "utf8");
    expect(raw).not.toContain("agnt_sk_live");
  });

  it("exposes metadata without the values, in the stored order", async () => {
    await setOrgKey("org_a", "agnt_sk_a", { keyId: "key_1", label: "deus-desktop test" });
    await setOrgKey("org_b", "agnt_sk_b", { keyId: "key_2" });

    const keys = await listOrgKeys();
    expect(keys).toMatchObject([
      { orgId: "org_a", keyId: "key_1", label: "deus-desktop test" },
      { orgId: "org_b", keyId: "key_2" },
    ]);
    expect(keys.some((key) => "encryptedValue" in key)).toBe(false);
  });

  it("status reports presence, the default organization first, and every usable one", async () => {
    expect(await getCloudCredentialsStatus()).toMatchObject({
      hasPlatformKey: false,
      platformOrgIds: [],
    });

    await setOrgKey("org_a", "agnt_sk_x", { label: "mac" });
    await setOrgKey("org_b", "agnt_sk_y", { label: "mac" });

    expect(await getCloudCredentialsStatus()).toMatchObject({
      hasPlatformKey: true,
      platformKeyLabel: "mac",
      platformOrgId: "org_a",
      platformOrgIds: ["org_a", "org_b"],
    });
  });

  it("writes a file older builds read: the default in entries.agntApiKey, the rest in orgKeys", async () => {
    await setOrgKey("org_a", "agnt_sk_a", { keyId: "key_1", label: "mac" });
    await setOrgKey("org_b", "agnt_sk_b", { keyId: "key_2" });

    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.entries)).toEqual(["agntApiKey"]);
    expect(stored.entries.agntApiKey).toMatchObject({
      encryptedValue: encrypted("agnt_sk_a"),
      orgId: "org_a",
      keyId: "key_1",
      label: "mac",
    });
    expect(typeof stored.entries.agntApiKey.createdAt).toBe("string");
    expect(Object.keys(stored.orgKeys)).toEqual(["org_b"]);
    expect(stored.orgKeys.org_b).toMatchObject({ orgId: "org_b", keyId: "key_2" });
  });

  it("reads an older build's single-key file as one organization, rewriting nothing", async () => {
    const legacy = JSON.stringify({
      version: 1,
      entries: {
        agntApiKey: {
          encryptedValue: encrypted("agnt_sk_legacy"),
          keyId: "key_9",
          orgId: "org_1",
          label: "deus-desktop mac",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeFile(CREDENTIALS_FILE(), legacy);
    const writes = vi.spyOn(credentialFile, "writeJsonFile");
    const deletes = vi.spyOn(credentialFile, "removeFile");

    expect(await getOrgKey("org_1")).toBe("agnt_sk_legacy");
    expect(await getOrgKeys()).toEqual({ org_1: "agnt_sk_legacy" });
    expect(await listOrgKeys()).toEqual([
      {
        orgId: "org_1",
        keyId: "key_9",
        label: "deus-desktop mac",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect((await getCloudCredentialsStatus()).platformOrgId).toBe("org_1");
    expect(writes).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(await readFile(CREDENTIALS_FILE(), "utf8")).toBe(legacy);
  });

  it("scrubs an older build's retired entries and keeps its key", async () => {
    await writeFile(
      CREDENTIALS_FILE(),
      JSON.stringify({
        version: 1,
        entries: {
          agntApiKey: { encryptedValue: encrypted("agnt_sk_legacy"), orgId: "org_1" },
          claudeOauthToken: { encryptedValue: "retired-claude-ciphertext" },
        },
      })
    );

    expect(await getOrgKey("org_1")).toBe("agnt_sk_legacy");
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.entries)).toEqual(["agntApiKey"]);
    expect(stored.orgKeys).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("retired");
  });

  it("rewrites this branch's version 2 file in the compatible shape, keeping every key", async () => {
    await writeFile(
      CREDENTIALS_FILE(),
      JSON.stringify({
        version: 2,
        orgKeys: {
          org_a: { encryptedValue: encrypted("agnt_sk_a"), orgId: "org_a", keyId: "key_1" },
          org_b: { encryptedValue: encrypted("agnt_sk_b"), orgId: "org_b", keyId: "key_2" },
        },
      })
    );

    expect(await getOrgKeys()).toEqual({ org_a: "agnt_sk_a", org_b: "agnt_sk_b" });
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.entries).toEqual({
      agntApiKey: { encryptedValue: encrypted("agnt_sk_a"), orgId: "org_a", keyId: "key_1" },
    });
    expect(stored.orgKeys).toEqual({
      org_b: { encryptedValue: encrypted("agnt_sk_b"), orgId: "org_b", keyId: "key_2" },
    });
  });

  it.each([
    ["a retired-only vault", { codexAuthJson: { encryptedValue: "retired-ciphertext" } }],
    ["a key that names no organization", { agntApiKey: { encryptedValue: encrypted("x") } }],
  ])("removes %s from disk on read", async (_name, entries) => {
    await writeFile(CREDENTIALS_FILE(), JSON.stringify({ version: 1, entries }));

    expect((await getCloudCredentialsStatus()).hasPlatformKey).toBe(false);
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deleting the default promotes the next key into entries.agntApiKey; deleting the last removes the file", async () => {
    await setOrgKey("org_a", "agnt_sk_a");
    await setOrgKey("org_b", "agnt_sk_b");
    await deleteOrgKey("org_a");
    expect(await getOrgKeys()).toEqual({ org_b: "agnt_sk_b" });
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.entries.agntApiKey.orgId).toBe("org_b");
    expect(stored.orgKeys).toBeUndefined();
    await deleteOrgKey("org_b");
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toThrow();

    await setOrgKey("org_a", "agnt_sk_a");
    await deleteAllOrgKeys();
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toThrow();
  });

  it("orders the keys as the platform lists the organizations, rewriting only when it differs", async () => {
    await setOrgKey("org_b", "agnt_sk_b");
    await setOrgKey("org_a", "agnt_sk_a");
    await orderOrgKeys(["org_a", "org_gone", "org_b"]);
    expect((await listOrgKeys()).map((key) => key.orgId)).toEqual(["org_a", "org_b"]);
    // The new default moves to where older builds read it.
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.entries.agntApiKey).toMatchObject({
      orgId: "org_a",
      encryptedValue: encrypted("agnt_sk_a"),
    });
    expect(Object.keys(stored.orgKeys)).toEqual(["org_b"]);

    const writes = vi.spyOn(credentialFile, "writeJsonFile");
    await orderOrgKeys(["org_a", "org_b"]);
    expect(writes).not.toHaveBeenCalled();
    expect(await getOrgKeys()).toEqual({ org_a: "agnt_sk_a", org_b: "agnt_sk_b" });
  });

  it.each(["replace", "delete"])("orders %s after an in-flight vault scrub", async (operation) => {
    await writeFile(
      CREDENTIALS_FILE(),
      JSON.stringify({
        version: 1,
        entries: {
          agntApiKey: { encryptedValue: encrypted("old-key"), orgId: "org_1" },
          codexAuthJson: { encryptedValue: "retired-ciphertext" },
        },
      })
    );

    let resumeCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      resumeCleanup = resolve;
    });
    let announceCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      announceCleanup = resolve;
    });
    const write = credentialFile.writeJsonFile;
    vi.spyOn(credentialFile, "writeJsonFile").mockImplementationOnce(async (path, value) => {
      announceCleanup();
      await cleanupGate;
      await write(path, value);
    });
    const reads = vi.spyOn(credentialFile, "readJsonFile");
    const deletes = vi.spyOn(credentialFile, "removeFile");
    const reading = getCloudCredentialsStatus();
    await cleanupStarted;
    const mutation =
      operation === "replace" ? setOrgKey("org_1", "new-key") : deleteOrgKey("org_1");
    try {
      await Promise.resolve();
      // The later operation cannot read or delete the stale scrub snapshot.
      expect(reads).toHaveBeenCalledTimes(1);
      expect(deletes).not.toHaveBeenCalled();
    } finally {
      resumeCleanup();
      await Promise.all([reading, mutation]);
    }
    if (operation === "replace") expect(await getOrgKey("org_1")).toBe("new-key");
    else
      await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("allows later credential writes after a failed write", async () => {
    vi.spyOn(credentialFile, "writeJsonFile").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(setOrgKey("org_1", "failed-key")).rejects.toThrow("disk unavailable");
    await setOrgKey("org_1", "working-key");
    expect(await getOrgKey("org_1")).toBe("working-key");
  });

  it("an undecryptable key is dropped instead of poisoning reads, and only that one", async () => {
    await setOrgKey("org_a", "agnt_sk_a");
    await setOrgKey("org_b", "agnt_sk_b");
    // Simulate an OS keychain reset for one entry: its bytes no longer decrypt.
    const raw = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    raw.entries.agntApiKey.encryptedValue = Buffer.from("garbage", "utf8").toString("base64");
    await writeFile(CREDENTIALS_FILE(), JSON.stringify(raw));

    expect(await getOrgKey("org_a")).toBeNull();
    expect(await getOrgKeys()).toEqual({ org_b: "agnt_sk_b" });
    expect((await getCloudCredentialsStatus()).platformOrgIds).toEqual(["org_b"]);
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    expect(stored.entries.agntApiKey.orgId).toBe("org_b");
  });
});
