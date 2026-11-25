import { describe, expect, it } from "vitest";
import {
  flattenFileTree,
  normalizeNavigationUrl,
  parseOmniboxUrl,
  searchWorkspaceFiles,
} from "@/features/workspace-tabs/lib/omnibox";
import { onLocalhost } from "@/features/workspace/lib/reach";
import type { FileTreeNode } from "@/features/file-browser/types";

describe("parseOmniboxUrl", () => {
  it("parses explicit http and https URLs", () => {
    expect(parseOmniboxUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(parseOmniboxUrl("https://deusmachine.ai/docs")).toBe("https://deusmachine.ai/docs");
  });

  it("parses localhost, IPv6 loopback, and port shorthand", () => {
    expect(parseOmniboxUrl("localhost:1420")).toBe("http://localhost:1420");
    expect(parseOmniboxUrl("localhost:3000/settings")).toBe("http://localhost:3000/settings");
    expect(parseOmniboxUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseOmniboxUrl("[::1]:3000")).toBe("http://[::1]:3000");
    expect(parseOmniboxUrl("[::1]:3000/health")).toBe("http://[::1]:3000/health");
    expect(parseOmniboxUrl(":5173")).toBe("http://localhost:5173");
    expect(parseOmniboxUrl(":3000/api")).toBe("http://localhost:3000/api");
  });

  it("parses bare domains as https", () => {
    expect(parseOmniboxUrl("stripe.com")).toBe("https://stripe.com");
    expect(parseOmniboxUrl("github.com/zvadaadam/deus-machine")).toBe(
      "https://github.com/zvadaadam/deus-machine"
    );
  });

  it("does not treat source filenames or phrases as URLs", () => {
    expect(parseOmniboxUrl("MainContent.tsx")).toBeNull();
    expect(parseOmniboxUrl("package.json")).toBeNull();
    expect(parseOmniboxUrl("README.md")).toBeNull();
    expect(parseOmniboxUrl("global.css")).toBeNull();
    expect(parseOmniboxUrl("search query")).toBeNull();
    expect(parseOmniboxUrl("")).toBeNull();
  });
});

describe("workspace file search", () => {
  const tree: FileTreeNode[] = [
    {
      name: "apps",
      path: "apps",
      type: "directory",
      children: [
        {
          name: "web",
          path: "apps/web",
          type: "directory",
          children: [
            { name: "MainContent.tsx", path: "apps/web/MainContent.tsx", type: "file" },
            { name: "ContentView.tsx", path: "apps/web/ContentView.tsx", type: "file" },
          ],
        },
      ],
    },
    { name: "package.json", path: "package.json", type: "file" },
    { name: "README.md", path: "README.md", type: "file" },
  ];

  it("flattens nested trees and ranks exact/prefix basename matches first", () => {
    const flat = flattenFileTree(tree);
    expect(flat).toHaveLength(4);

    const results = searchWorkspaceFiles(flat, "main");
    expect(results[0]?.path).toBe("apps/web/MainContent.tsx");

    const byDir = searchWorkspaceFiles(flat, "apps/web");
    expect(byDir.map((r) => r.name)).toEqual(["ContentView.tsx", "MainContent.tsx"]);
  });
});

describe("normalizeNavigationUrl & onLocalhost", () => {
  it("normalizes explicit URL bar input including port shorthand, IPv6 loopback, and bare domains", () => {
    expect(normalizeNavigationUrl(":1420")).toBe("http://localhost:1420");
    expect(normalizeNavigationUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeNavigationUrl("[::1]:5173/test")).toBe("http://[::1]:5173/test");
    expect(normalizeNavigationUrl("example.com")).toBe("https://example.com");
    expect(normalizeNavigationUrl("https://deusmachine.ai")).toBe("https://deusmachine.ai");
  });

  it("classifies loopback hosts including default ports and IPv6 via reach.onLocalhost", () => {
    expect(onLocalhost("http://localhost:3000")).toEqual({ port: 3000, rest: "/" });
    expect(onLocalhost("http://localhost/health")).toEqual({ port: 80, rest: "/health" });
    expect(onLocalhost("https://localhost/secure")).toEqual({ port: 443, rest: "/secure" });
    expect(onLocalhost("http://[::1]:5173/settings?tab=1#top")).toEqual({
      port: 5173,
      rest: "/settings?tab=1#top",
    });
    expect(onLocalhost("https://stripe.com/docs")).toBeNull();
  });
});
