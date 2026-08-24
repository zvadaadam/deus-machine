import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const CREDENTIALS_FILE = () => join(electronMocks.userDataDir, "deus-cloud-credentials.json");

beforeEach(async () => {
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-creds-"));
});

afterEach(async () => {
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
      hasClaudeSubscription: false,
    });

    await setCloudCredential("claudeOauthToken", "sk-ant-oat01-secret");
    await setCloudCredential("agntApiKey", "agnt_sk_x", { label: "mac" });

    expect(await getCloudCredentialsStatus()).toMatchObject({
      hasPlatformKey: true,
      platformKeyLabel: "mac",
      hasClaudeSubscription: true,
    });
  });

  it("deleting the last entry removes the file entirely", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_x");
    await deleteCloudCredential("agntApiKey");
    await expect(readFile(CREDENTIALS_FILE(), "utf8")).rejects.toThrow();
  });

  it("an undecryptable entry is dropped instead of poisoning reads", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_x");
    // Simulate an OS keychain reset: stored bytes no longer decrypt.
    const raw = JSON.parse(await readFile(CREDENTIALS_FILE(), "utf8"));
    raw.entries.agntApiKey.encryptedValue = Buffer.from("garbage", "utf8").toString("base64");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(CREDENTIALS_FILE(), JSON.stringify(raw));

    expect(await getCloudCredential("agntApiKey")).toBeNull();
    expect((await getCloudCredentialsStatus()).hasPlatformKey).toBe(false);
  });
});
