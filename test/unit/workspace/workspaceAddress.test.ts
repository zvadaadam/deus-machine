import { defaultParseSearch } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "@shared/lib/uuid";
import {
  homeForMissingWorkspace,
  linkToWorkspace,
  workspaceAddress,
  workspaceSearch,
} from "@/features/workspace/lib/workspaceAddress";

const capabilities = vi.hoisted(() => ({ singleWindow: false }));
vi.mock("@/platform/capabilities", () => ({ capabilities }));

const workspaceId = uuidv7();
const sessionId = uuidv7();
const origin = "https://deusmachine.ai";

afterEach(() => {
  capabilities.singleWindow = false;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("workspace addresses", () => {
  it.each([
    [undefined, "/"],
    ["local", "/s/local"],
    ["computer A", "/s/computer%20A"],
  ])("round-trips Home, a workspace and a chat on %s", (server, home) => {
    expect(workspaceAddress(server)).toBe(home);
    const path = `${home === "/" ? "" : home}/w/${workspaceId}`;
    expect(workspaceAddress(server, workspaceId)).toBe(path);
    const address = new URL(workspaceAddress(server, workspaceId, sessionId), origin);
    expect(address.pathname).toBe(path);
    expect(workspaceSearch(defaultParseSearch(address.search)).session).toBe(sessionId);
  });

  it("round-trips a caller-supplied UUIDv4 as both ids on web-direct", () => {
    const cloudSession = crypto.randomUUID();
    const address = new URL(workspaceAddress(null, cloudSession, cloudSession), origin);
    expect(address.pathname).toBe(`/w/${cloudSession}`);
    expect(workspaceSearch(defaultParseSearch(address.search))).toEqual({ session: cloudSession });
  });

  it.each(["67DC16B5-C317-4474-8127-DC8F2C25E751", "ABCDEF12-ABCD-F123-8123-ABCDEF123456"])(
    "preserves upper-case %s in the workspace path and chat query",
    (id) => {
      const address = new URL(workspaceAddress(undefined, id, id), origin);
      expect(address.pathname).toBe(`/w/${id}`);
      expect(workspaceSearch(defaultParseSearch(address.search)).session).toBe(id);
    }
  );

  it("preserves a web-direct link on a missing row and returns Home for a confirmed relay miss", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    vi.stubEnv("VITE_BACKEND_PORT", "");
    vi.stubGlobal("window", {
      location: new URL(workspaceAddress(null, workspaceId, sessionId), origin),
    });
    expect(homeForMissingWorkspace(undefined)).toBeUndefined();
    vi.stubGlobal("window", {
      location: new URL(workspaceAddress("mac", workspaceId, sessionId), origin),
    });
    expect(homeForMissingWorkspace("mac")).toBe("/s/mac");
  });

  it.each([
    "",
    "garbage",
    "true",
    "123",
    "..%2Fpath",
    `${sessionId}%0A`,
    "{}",
    "[]",
    `${sessionId}&session=${sessionId}`,
  ])("drops a refused session in ?session=%s", (value) => {
    const search = defaultParseSearch(`?session=${value}`);
    expect({ ...search, ...workspaceSearch(search) }.session).toBeUndefined();
  });
});

describe("Copy link", () => {
  it("copies desktop workspace and chat links", () => {
    capabilities.singleWindow = true;
    expect(linkToWorkspace({ workspaceId })).toBe(`deus://workspace?id=${workspaceId}`);
    expect(linkToWorkspace({ workspaceId, sessionId })).toBe(
      `deus://workspace?id=${workspaceId}&session=${sessionId}`
    );
  });

  it.each([
    ["/w/elsewhere", ""],
    ["/s/local/settings", "/s/local"],
    ["/s/computer%20A/", "/s/computer%20A"],
  ])("uses this browser's origin and computer from %s", (pathname, computer) => {
    vi.stubGlobal("window", { location: new URL(`${pathname}?x=1#fragment`, origin) });
    const workspace = `${origin}${computer}/w/${workspaceId}`;
    expect(linkToWorkspace({ workspaceId })).toBe(workspace);
    expect(linkToWorkspace({ workspaceId, sessionId })).toBe(`${workspace}?session=${sessionId}`);
  });
});
