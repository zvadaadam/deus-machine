import { describe, expect, it } from "vitest";
import {
  agentConfigOf,
  CLOUD_FILE_UNSHOWN,
  CLOUD_LOCALHOST,
  localFolder,
  needsPreviewAddress,
  openableFolder,
  openAddress,
  openFile,
  type ChatPlace,
} from "@/features/workspace/lib/reach";

// Rule 1: the workspace's folder on this computer, or none.
describe("localFolder", () => {
  it.each([
    ["a local workspace with its checkout", "worktree", "/r/.deus/a", "s1", "/r/.deus/a"],
    ["a local workspace before its checkout", "worktree", "/r/.deus/a", null, null],
    ["a local workspace with no path", "worktree", "", "s1", null],
    ["a cloud workspace", "cloud", "", "s1", null],
    ["a cloud workspace whose row names a path", "cloud", "/r/.deus/a", "s1", null],
  ] as const)("%s", (_name, kind, workspace_path, current_session_id, expected) => {
    expect(localFolder({ kind, workspace_path, current_session_id })).toBe(expected);
  });

  it("names the configuration where the agent runs: the workspace's folder, or the cloud", () => {
    expect(
      agentConfigOf({ kind: "worktree", workspace_path: "/r/.deus/a", current_session_id: "s" })
    ).toEqual({ where: "local", folder: "/r/.deus/a" });
    expect(
      agentConfigOf({ kind: "worktree", workspace_path: "/r/.deus/a", current_session_id: null })
    ).toEqual({ where: "local", folder: null });
    expect(agentConfigOf({ kind: "cloud", workspace_path: "", current_session_id: "s" })).toEqual({
      where: "cloud",
    });
  });
});

// Rule 1 for opening things here: the folder, only where this client can open it.
describe("openableFolder", () => {
  const ready = { kind: "worktree", workspace_path: "/r/.deus/a", current_session_id: "s1" };
  it("is the folder in the desktop app, and nothing where this client cannot open it", () => {
    expect(openableFolder(ready, true)).toBe("/r/.deus/a");
    expect(openableFolder(ready, false)).toBeNull();
    expect(openableFolder({ ...ready, kind: "cloud" }, true)).toBeNull();
  });
});

// Rule 2: where an address or a file from the chat opens.
const local: ChatPlace = { cloud: false, folder: "/r/.deus/a" };
const cloud: ChatPlace = {
  cloud: true,
  folder: null,
  previewTemplate: "https://{{port}}-sbx.e2b.app",
  previewTab: true,
};
const cloudNoAddress: ChatPlace = { ...cloud, previewTemplate: null };
const cloudNoTab: ChatPlace = { ...cloud, previewTab: false };

describe("openAddress", () => {
  it("opens a local chat's address in the person's browser where this client has no Browser tab", () => {
    const noTab: ChatPlace = { ...local, browserTab: false };
    expect(openAddress("https://example.com/x", noTab)).toEqual({
      to: "external",
      url: "https://example.com/x",
    });
    expect(openAddress("http://localhost:3000", noTab)).toEqual({
      to: "external",
      url: "http://localhost:3000",
    });
    expect(openAddress("http://localhost:3000", { ...local, browserTab: true })).toEqual({
      to: "browser-tab",
      url: "http://localhost:3000",
    });
  });

  it.each([
    [
      "local, internet",
      "https://example.com/x",
      local,
      false,
      { to: "browser-tab", url: "https://example.com/x" },
    ],
    [
      "local, localhost",
      "http://localhost:3000",
      local,
      false,
      { to: "browser-tab", url: "http://localhost:3000" },
    ],
    [
      "local, external",
      "http://localhost:3000",
      local,
      true,
      { to: "external", url: "http://localhost:3000" },
    ],
    [
      "cloud, internet",
      "https://example.com/x",
      cloud,
      false,
      { to: "external", url: "https://example.com/x" },
    ],
    [
      "cloud, internet, external",
      "https://example.com/x",
      cloud,
      true,
      { to: "external", url: "https://example.com/x" },
    ],
    [
      "cloud, localhost with a path",
      "http://localhost:5173/dash?a=1",
      cloud,
      false,
      { to: "cloud-preview", port: 5173, rest: "/dash?a=1" },
    ],
    [
      "cloud, 127.0.0.1",
      "http://127.0.0.1:8080/",
      cloud,
      false,
      { to: "cloud-preview", port: 8080, rest: "/" },
    ],
    [
      "cloud, 0.0.0.0",
      "http://0.0.0.0:3000",
      cloud,
      false,
      { to: "cloud-preview", port: 3000, rest: "/" },
    ],
    [
      "cloud, localhost, external: the preview's address in the person's browser",
      "http://localhost:3000/a",
      cloud,
      true,
      { to: "external", url: "https://3000-sbx.e2b.app/a" },
    ],
    [
      "cloud, localhost, no address reported",
      "http://localhost:3000",
      cloudNoAddress,
      false,
      { to: "say", message: CLOUD_LOCALHOST },
    ],
    [
      "cloud, localhost, no address, external",
      "http://localhost:3000",
      cloudNoAddress,
      true,
      { to: "say", message: CLOUD_LOCALHOST },
    ],
    [
      "cloud, localhost, no preview tab here",
      "http://localhost:3000",
      cloudNoTab,
      false,
      { to: "say", message: CLOUD_LOCALHOST },
    ],
  ] as const)("%s", (_name, url, place, external, expected) => {
    expect(openAddress(url, place, external)).toEqual(expected);
  });

  it("never opens this computer's localhost for a cloud workspace", () => {
    for (const place of [cloud, cloudNoAddress, cloudNoTab]) {
      for (const external of [false, true]) {
        const opening = openAddress("http://localhost:3000", place, external);
        expect(JSON.stringify(opening)).not.toContain("localhost");
      }
    }
  });
});

describe("needsPreviewAddress", () => {
  it("is only a cloud chat's address on localhost: everything else is decided in the click", () => {
    expect(needsPreviewAddress("http://localhost:3000/a", { cloud: true })).toBe(true);
    expect(needsPreviewAddress("http://127.0.0.1:8080", { cloud: true })).toBe(true);
    expect(needsPreviewAddress("https://example.com/x", { cloud: true })).toBe(false);
    expect(needsPreviewAddress("http://localhost:3000/a", { cloud: false })).toBe(false);
  });
});

describe("openFile", () => {
  it.each([
    [
      "local html preview",
      "site/index.html",
      local,
      "preview",
      { to: "file-preview", path: "site/index.html" },
    ],
    [
      "local pdf preview",
      "out/report.pdf",
      local,
      "preview",
      { to: "file-preview", path: "out/report.pdf" },
    ],
    [
      "local in Files",
      "README.md",
      local,
      "files",
      { to: "files", path: "README.md", target: "files" },
    ],
    [
      "local default app",
      "out/deck.pptx",
      local,
      "default-app",
      { to: "default-app", path: "out/deck.pptx" },
    ],
    ["local Finder", "out/deck.pptx", local, "finder", { to: "finder", path: "out/deck.pptx" }],
    [
      "cloud html: the Files tab",
      "site/index.html",
      cloud,
      "preview",
      { to: "files", path: "site/index.html", target: "files" },
    ],
    [
      "cloud pdf: says so",
      "out/report.pdf",
      cloud,
      "preview",
      { to: "say", message: CLOUD_FILE_UNSHOWN },
    ],
    [
      "cloud image: says so",
      "shot.png",
      cloud,
      "preview",
      { to: "say", message: CLOUD_FILE_UNSHOWN },
    ],
    [
      "cloud in Files",
      "README.md",
      cloud,
      "files",
      { to: "files", path: "README.md", target: "files" },
    ],
    ["cloud default app: not offered", "out/deck.pptx", cloud, "default-app", { to: "none" }],
    ["cloud Finder: not offered", "out/deck.pptx", cloud, "finder", { to: "none" }],
  ] as const)("%s", (_name, path, place, how, expected) => {
    expect(openFile(path, place, how)).toEqual(expected);
  });
});
