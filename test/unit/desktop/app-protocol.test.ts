import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, protocol: {} }));

import { originOf, rendererFileFor, rendererOrigin } from "../../../apps/desktop/main/app-protocol";

const root = path.resolve("/Applications/Deus.app/Contents/Resources/app.asar/out/renderer");
const files = new Set([
  path.join(root, "index.html"),
  path.join(root, "assets/index-abc.js"),
  path.join(root, "favicon.png"),
]);
const exists = (file: string) => files.has(file);
const index = path.join(root, "index.html");
const resolve = (url: string) => rendererFileFor(root, url, exists);

describe("rendererFileFor", () => {
  it.each([
    ["app://deus/", index],
    ["app://deus/index.html", index],
    ["app://deus/assets/index-abc.js", path.join(root, "assets/index-abc.js")],
    ["app://deus/favicon.png?v=2#x", path.join(root, "favicon.png")],
    // Not a file in the folder: the app's own page.
    ["app://deus/s/local/w/123", index],
    ["app://deus/assets", index],
    ["app://deus/assets/missing.js", index],
  ])("serves %s", (url, file) => {
    expect(resolve(url)).toBe(file);
  });

  it.each([
    // URL parsing resolves plain dot segments inside the folder...
    ["app://deus/../../../../etc/passwd", index],
    ["app://deus/assets/../favicon.png", path.join(root, "favicon.png")],
    // (an encoded dot segment is a dot segment to URL parsing too)
    ["app://deus/%2e%2e/%2e%2e/main/index.js", index],
    ["app://deus/%2E%2E", index],
  ])("keeps %s inside the renderer", (url, file) => {
    expect(resolve(url)).toBe(file);
  });

  it.each([
    // ...but not an encoded slash, which decodes to a path that leaves it.
    "app://deus/..%2f..%2fmain%2findex.js",
    "app://deus/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fInfo.plist",
    // Another host, another scheme, a NUL byte, a malformed escape.
    "app://other/index.html",
    "file:///etc/passwd",
    "app://deus/index.html%00.png",
    "app://deus/%E0%A4%A",
    "not a url",
  ])("refuses %s", (url) => {
    expect(resolve(url)).toBeNull();
  });
});

describe("rendererOrigin", () => {
  it("is app://deus unless a dev window loads from Vite", () => {
    expect(rendererOrigin({ isDev: false })).toBe("app://deus");
    expect(rendererOrigin({ isDev: false, rendererUrl: "http://localhost:1420/" })).toBe(
      "app://deus"
    );
    expect(rendererOrigin({ isDev: true })).toBe("app://deus");
    expect(rendererOrigin({ isDev: true, rendererUrl: "http://localhost:1420/" })).toBe(
      "http://localhost:1420"
    );
  });

  it("names the origin of a custom scheme, which Node's URL calls null", () => {
    expect(originOf("app://deus/s/local")).toBe("app://deus");
    expect(originOf("http://localhost:1420/x?y")).toBe("http://localhost:1420");
    expect(originOf("file:///Applications/Deus.app")).toBeNull();
    expect(originOf("nonsense")).toBeNull();
  });
});
