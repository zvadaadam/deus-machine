import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockApp, mockDialog } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: true,
    getPath: vi.fn(),
    moveToApplicationsFolder: vi.fn(),
    quit: vi.fn(),
  },
  mockDialog: {
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: mockApp,
  dialog: mockDialog,
}));

import {
  ensureInstalledInApplications,
  isApplicationsInstallPath,
} from "../../../apps/desktop/main/install-preflight";

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-install-preflight-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  mockApp.getPath.mockReset();
  mockApp.moveToApplicationsFolder.mockReset();
  mockApp.quit.mockReset();
  mockDialog.showMessageBox.mockReset();
  mockDialog.showMessageBoxSync.mockReset();
  process.env = { ...originalEnv };
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: originalPlatform,
  });
});

describe("desktop install preflight", () => {
  it("accepts user Applications paths when the executable and home use different symlink spellings", () => {
    const root = createTempRoot();
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    const executablePath = path.join(
      realHome,
      "Applications",
      "Deus.app",
      "Contents",
      "MacOS",
      "Deus"
    );

    mkdirSync(path.dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "");
    symlinkSync(realHome, linkedHome, "dir");

    expect(isApplicationsInstallPath(executablePath, linkedHome)).toBe(true);
  });

  it("rejects paths outside global or user Applications", () => {
    expect(
      isApplicationsInstallPath("/Users/test/Downloads/Deus.app/Contents/MacOS/Deus", "/Users/test")
    ).toBe(false);
  });

  it("accepts the process HOME Applications path when Electron reports a different home", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const root = createTempRoot();
    const executablePath = path.join(
      root,
      "home",
      "Applications",
      "Deus.app",
      "Contents",
      "MacOS",
      "Deus"
    );
    mkdirSync(path.dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "");
    process.env.HOME = path.join(root, "home");
    mockApp.getPath.mockImplementation((name: string) => {
      if (name === "exe") return executablePath;
      if (name === "home") return "/Users/runner";
      return root;
    });

    await expect(ensureInstalledInApplications()).resolves.toBe(false);
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
  });
});
