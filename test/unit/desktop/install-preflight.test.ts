import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockApp, mockDialog, mockExecFileSync } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: true,
    getPath: vi.fn(),
    getVersion: vi.fn(),
    moveToApplicationsFolder: vi.fn(),
    releaseSingleInstanceLock: vi.fn(),
    quit: vi.fn(),
  },
  mockDialog: {
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
  },
  mockExecFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mockApp,
  dialog: mockDialog,
}));

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import {
  ensureInstalledInApplications,
  isApplicationsInstallPath,
  shouldReplaceExistingInstall,
} from "../../../apps/desktop/main/install-preflight";

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
const originalArch = process.arch;
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
  mockApp.getVersion.mockReset();
  mockApp.moveToApplicationsFolder.mockReset();
  mockApp.releaseSingleInstanceLock.mockReset();
  mockApp.quit.mockReset();
  mockDialog.showMessageBox.mockReset();
  mockDialog.showMessageBoxSync.mockReset();
  mockExecFileSync.mockReset();
  process.env = { ...originalEnv };
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: originalPlatform,
  });
  Object.defineProperty(process, "arch", {
    configurable: true,
    enumerable: true,
    value: originalArch,
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
    expect(mockApp.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  function setupTransientLaunch(): string {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const root = createTempRoot();
    const executablePath = path.join(
      root,
      "Volumes",
      "Deus",
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
      if (name === "home") return path.join(root, "home");
      return root;
    });
    mockApp.getVersion.mockReturnValue("0.3.8");
    return executablePath;
  }

  const CURRENT_ARCH = originalArch === "arm64" ? "arm64" : "x86_64";
  const OTHER_ARCH = CURRENT_ARCH === "arm64" ? "x86_64" : "arm64";

  function mockInstalledVersion(
    version: string | null,
    archs: string = CURRENT_ARCH,
    procTranslated = "0"
  ): void {
    mockExecFileSync.mockImplementation((file: string) => {
      if (file === "/usr/bin/plutil") {
        if (version === null) throw new Error("missing plist");
        return `${version}\n`;
      }
      if (file === "/usr/bin/lipo") {
        return `${archs}\n`;
      }
      if (file === "/usr/sbin/sysctl") {
        return `${procTranslated}\n`;
      }
      return "";
    });
  }

  it("silently installs into Applications when launched from a transient location", async () => {
    setupTransientLaunch();
    mockApp.moveToApplicationsFolder.mockReturnValue(true);

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockApp.moveToApplicationsFolder).toHaveBeenCalledTimes(1);
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
    expect(mockDialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(mockApp.quit).not.toHaveBeenCalled();
  });

  it("quits with manual-move guidance when the automatic install throws", async () => {
    const executablePath = setupTransientLaunch();
    mockApp.moveToApplicationsFolder.mockImplementation(() => {
      throw new Error("User rejected the authorization request");
    });
    mockDialog.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1);
    const detail = mockDialog.showMessageBox.mock.calls[0][0].detail as string;
    expect(detail).toContain("User rejected the authorization request");
    expect(detail).toContain(executablePath);
    expect(mockApp.quit).toHaveBeenCalledTimes(1);
  });

  it("quits with manual-move guidance when the mover reports no move", async () => {
    setupTransientLaunch();
    mockApp.moveToApplicationsFolder.mockReturnValue(false);
    mockDialog.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mockApp.quit).toHaveBeenCalledTimes(1);
  });

  it("replaces an older installed copy silently", async () => {
    setupTransientLaunch();
    mockInstalledVersion("0.3.6");
    mockApp.moveToApplicationsFolder.mockImplementation(
      (options: { conflictHandler: (conflictType: string) => boolean }) =>
        options.conflictHandler("exists")
    );

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
    expect(mockApp.quit).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      "/usr/bin/open",
      expect.anything(),
      expect.anything()
    );
  });

  it("opens a same-or-newer installed copy instead of downgrading it", async () => {
    setupTransientLaunch();
    mockInstalledVersion("0.4.0");
    mockApp.moveToApplicationsFolder.mockImplementation(
      (options: { conflictHandler: (conflictType: string) => boolean }) =>
        options.conflictHandler("exists")
    );

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["/Applications/Deus.app"],
      expect.anything()
    );
    expect(mockApp.quit).toHaveBeenCalledTimes(1);
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();

    // The lock must be released before the installed copy launches, or it
    // loses the single-instance race against our still-exiting process.
    const releaseOrder = mockApp.releaseSingleInstanceLock.mock.invocationCallOrder[0];
    const openOrder =
      mockExecFileSync.mock.invocationCallOrder[
        mockExecFileSync.mock.calls.findIndex((call) => call[0] === "/usr/bin/open")
      ];
    expect(releaseOrder).toBeLessThan(openOrder);
  });

  it("replaces a same-version install that does not run natively on this machine", async () => {
    setupTransientLaunch();
    mockInstalledVersion("0.3.8", OTHER_ARCH);
    mockApp.moveToApplicationsFolder.mockImplementation(
      (options: { conflictHandler: (conflictType: string) => boolean }) =>
        options.conflictHandler("exists")
    );

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockApp.quit).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      "/usr/bin/open",
      expect.anything(),
      expect.anything()
    );
  });

  it("never lets a Rosetta build displace a same-version native install", async () => {
    setupTransientLaunch();
    // x64 DMG opened on Apple Silicon: process.arch reports x64 under
    // Rosetta while the machine (sysctl.proc_translated=1) is arm64.
    Object.defineProperty(process, "arch", {
      configurable: true,
      enumerable: true,
      value: "x64",
    });
    mockInstalledVersion("0.3.8", "arm64", "1");
    mockApp.moveToApplicationsFolder.mockImplementation(
      (options: { conflictHandler: (conflictType: string) => boolean }) =>
        options.conflictHandler("exists")
    );

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["/Applications/Deus.app"],
      expect.anything()
    );
    expect(mockApp.quit).toHaveBeenCalledTimes(1);
  });

  it("defers running-copy conflicts to the mover without reading versions", async () => {
    setupTransientLaunch();
    mockApp.moveToApplicationsFolder.mockImplementation(
      (options: { conflictHandler: (conflictType: string) => boolean }) =>
        options.conflictHandler("existsAndRunning")
    );

    await expect(ensureInstalledInApplications()).resolves.toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("shouldReplaceExistingInstall", () => {
  it.each([
    // installed, incoming, replaceSameVersionForArch, expected
    [null, "0.3.8", false, true],
    ["not-a-version", "0.3.8", false, true],
    ["0.3.6", "0.3.8", false, true],
    ["0.3.8", "0.3.8", false, false],
    ["0.4.0", "0.3.8", false, false],
    ["10.0", "9.9.9", false, false],
    // Prerelease ordering: releases outrank prereleases of the same core.
    ["0.3.8", "0.3.8-beta.1", false, false],
    ["0.3.8-beta.1", "0.3.8", false, true],
    ["0.3.8-beta.1", "0.3.8-beta.2", false, true],
    ["0.3.8-beta.2", "0.3.8-beta.10", false, true],
    ["0.3.8-alpha", "0.3.8-alpha.1", false, true],
    // An arch-justified replacement applies to same versions only — a newer
    // install is never displaced.
    ["0.3.8", "0.3.8", true, true],
    ["0.4.0", "0.3.8", true, false],
  ])(
    "installed=%s incoming=%s archReplace=%s → replace=%s",
    (installedVersion, incomingVersion, replaceSameVersionForArch, expected) => {
      expect(
        shouldReplaceExistingInstall(
          installedVersion as string | null,
          incomingVersion as string,
          replaceSameVersionForArch as boolean
        )
      ).toBe(expected);
    }
  );
});
