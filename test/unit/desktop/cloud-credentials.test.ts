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
  deleteCloudCredential,
  getCloudCredential,
  getCloudCredentialMeta,
  getCloudCredentialsStatus,
  setCloudCredential,
} from "../../../apps/desktop/main/cloud-credentials";
import * as credentialFile from "../../../apps/desktop/main/safe-storage-file";

const CREDENTIALS_FILE = () => join(electronMocks.userDataDir, "deus-cloud-credentials.json");

beforeEach(async () => {
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-creds-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(electronMocks.userDataDir, { recursive: true, force: true });
});

describe("cloud credential store", () => {
  it("round-trips a value and never writes it in plaintext", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_live_secret", {
      keyId: "key_1",
      orgId: "org_1",
      label: "deus-desktop test",
    });

    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_live_secret");

    const raw = await readFile(CREDENTIALS_FILE(), "utf8");
    expect(raw).not.toContain("agnt_sk_live_secret");
  });

  it("exposes meta without the value", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_live_secret", {
      keyId: "key_1",
      orgId: "org_1",
      label: "deus-desktop test",
    });

    const meta = await getCloudCredentialMeta("agntApiKey");
    expect(meta).toMatchObject({ keyId: "key_1", orgId: "org_1", label: "deus-desktop test" });
    expect(meta && "encryptedValue" in meta).toBe(false);
  });

  it("status reports presence flags only", async () => {
    expect(await getCloudCredentialsStatus()).toMatchObject({
      hasPlatformKey: false,
    });

    await setCloudCredential("agntApiKey", "agnt_sk_x", { label: "mac" });

    expect(await getCloudCredentialsStatus()).toMatchObject({
      hasPlatformKey: true,
      platformKeyLabel: "mac",
    });
  });

  it("deleting the last entry removes the file entirely", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_x");
    await deleteCloudCredential("agntApiKey");
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toThrow();
  });

  it("removes retired ciphertext from disk while retaining the device key", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_x", { keyId: "key_1" });
    const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    stored.entries.claudeOauthToken = { encryptedValue: "retired-claude-ciphertext" };
    stored.entries.codexAuthJson = { encryptedValue: "retired-codex-ciphertext" };
    await writeFile(CREDENTIALS_FILE(), JSON.stringify(stored));

    expect((await getCloudCredentialsStatus()).hasPlatformKey).toBe(true);
    expect(JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"))).toEqual({
      version: 1,
      entries: { agntApiKey: stored.entries.agntApiKey },
    });
    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_x");
  });

  it.each(["read", "delete"])("removes a retired-only vault on %s", async (operation) => {
    await writeFile(
      CREDENTIALS_FILE(),
      JSON.stringify({
        version: 1,
        entries: { codexAuthJson: { encryptedValue: "retired-ciphertext" } },
      })
    );

    if (operation === "read")
      expect((await getCloudCredentialsStatus()).hasPlatformKey).toBe(false);
    else await deleteCloudCredential("agntApiKey");
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["replace", "delete"])(
    "orders %s after an in-flight vault cleanup",
    async (operation) => {
      await setCloudCredential("agntApiKey", "old-key");
      const stored = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
      stored.entries.codexAuthJson = { encryptedValue: "retired-ciphertext" };
      await writeFile(CREDENTIALS_FILE(), JSON.stringify(stored));

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
        operation === "replace"
          ? setCloudCredential("agntApiKey", "new-key")
          : deleteCloudCredential("agntApiKey");
      try {
        await Promise.resolve();
        // The later operation cannot read or delete the stale cleanup snapshot.
        expect(reads).toHaveBeenCalledTimes(1);
        expect(deletes).not.toHaveBeenCalled();
      } finally {
        resumeCleanup();
        await Promise.all([reading, mutation]);
      }
      if (operation === "replace") expect(await getCloudCredential("agntApiKey")).toBe("new-key");
      else
        await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
    }
  );

  it("allows later credential writes after a failed write", async () => {
    vi.spyOn(credentialFile, "writeJsonFile").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(setCloudCredential("agntApiKey", "failed-key")).rejects.toThrow(
      "disk unavailable"
    );
    await setCloudCredential("agntApiKey", "working-key");
    expect(await getCloudCredential("agntApiKey")).toBe("working-key");
  });

  it("an undecryptable entry is dropped instead of poisoning reads", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_x");
    // Simulate an OS keychain reset: stored bytes no longer decrypt.
    const raw = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    raw.entries.agntApiKey.encryptedValue = Buffer.from("garbage", "utf8").toString("base64");
    await writeFile(CREDENTIALS_FILE(), JSON.stringify(raw));

    expect(await getCloudCredential("agntApiKey")).toBeNull();
    expect((await getCloudCredentialsStatus()).hasPlatformKey).toBe(false);
  });
});
