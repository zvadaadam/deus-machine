import { describe, expect, it } from "vitest";

import {
  createWorkspacePreviewUrl,
  extractChatResources,
  extractMarkdownLinkDestinations,
  extractSingleLocalUrl,
  normalizeResourcePath,
} from "../../../apps/web/src/features/session/lib/chatResources";
import type { Part } from "../../../shared/messages/types";

function textPart(text: string, partIndex = 0): Part {
  return {
    type: "TEXT",
    id: `text-${partIndex}`,
    sessionId: "session-1",
    messageId: "message-1",
    partIndex,
    text,
    state: "DONE",
  };
}

function writePart(paths: string[], partIndex = 0): Part {
  return {
    type: "TOOL",
    id: `tool-${partIndex}`,
    sessionId: "session-1",
    messageId: "message-1",
    partIndex,
    toolCallId: `call-${partIndex}`,
    toolName: "apply_patch",
    kind: "write",
    locations: paths.map((path) => ({ path })),
    state: {
      status: "COMPLETED",
      title: "Edit files",
      time: { start: "2026-05-09T00:00:00.000Z", end: "2026-05-09T00:00:01.000Z" },
      content: paths.map((path) => ({ type: "diff" as const, path, newText: "" })),
    },
  };
}

describe("chatResources", () => {
  it("turns markdown links to supported files into file resources", () => {
    const resources = extractChatResources({
      parts: [textPart("Open [README](README.md)")],
      isComplete: true,
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: "file",
      title: "README.md",
      subtitle: "Document · MD",
      primaryAction: { kind: "deus-file", path: "README.md" },
    });
  });

  it("does not turn bare file names into resources without known paths", () => {
    const resources = extractChatResources({
      parts: [textPart("Open README.md")],
      isComplete: true,
    });

    expect(resources).toEqual([]);
  });

  it("does not create cards for unsupported archive links", () => {
    const resources = extractChatResources({
      parts: [textPart("Download [DMG](dist/App.dmg)")],
      isComplete: true,
    });

    expect(resources).toEqual([]);
  });

  it("turns a single local URL with explicit port into a website resource", () => {
    const resources = extractChatResources({
      parts: [textPart("Open it here: http://127.0.0.1:5173/")],
      isComplete: true,
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: "website",
      url: "http://127.0.0.1:5173/",
      primaryAction: { kind: "deus-browser", url: "http://127.0.0.1:5173/" },
      secondaryActions: [{ kind: "system-browser", url: "http://127.0.0.1:5173/" }],
    });
  });

  it("does not promote external URLs or local URLs without ports", () => {
    expect(extractSingleLocalUrl("https://github.com/foo/bar")).toBeNull();
    expect(extractSingleLocalUrl("http://localhost/")).toBeNull();
  });

  it("does not promote multiple local URLs", () => {
    expect(extractSingleLocalUrl("http://localhost:3000 and http://localhost:5173")).toBeNull();
  });

  it("keeps local website resources alongside file resources", () => {
    const resources = extractChatResources({
      parts: [textPart("[README](README.md)\n\nhttp://localhost:5173/")],
      isComplete: true,
    });

    expect(resources.map((resource) => resource.type)).toEqual(["file", "website"]);
  });

  it("does not create end cards for source file links", () => {
    const resources = extractChatResources({
      parts: [textPart("[events](shared/events.ts)")],
      isComplete: true,
    });

    expect(resources).toEqual([]);
  });

  it("does not create end cards for image links", () => {
    const resources = extractChatResources({
      parts: [textPart("[icon](apps/desktop/build/icon.png)")],
      isComplete: true,
    });

    expect(resources).toEqual([]);
  });

  it("uses a single edited html file as a website fallback", () => {
    const resources = extractChatResources({
      parts: [writePart(["dist/index.html"]), textPart("Built the page", 1)],
      isComplete: true,
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: "website",
      path: "dist/index.html",
      primaryAction: { kind: "deus-browser-file", path: "dist/index.html" },
    });
  });

  it("rejects path traversal and absolute paths outside the workspace", () => {
    expect(normalizeResourcePath("../secret.md")).toBeNull();
    expect(normalizeResourcePath("/tmp/secret.md", "/workspace/project")).toBeNull();
    expect(normalizeResourcePath("/workspace/project/docs/README.md", "/workspace/project")).toBe(
      "docs/README.md"
    );
  });

  it("skips fenced and inline code links while parsing markdown destinations", () => {
    const markdown = [
      "```md",
      "[Nope](README.md)",
      "```",
      "Use `[AlsoNope](docs/nope.md)` as an example.",
      "[Yes](docs/README.md)",
    ].join("\n");

    expect(extractMarkdownLinkDestinations(markdown)).toEqual(["docs/README.md"]);
  });

  it("builds backend preview URLs for workspace paths", () => {
    expect(
      createWorkspacePreviewUrl("http://localhost:54196/api", "workspace 1", "assets/icon 1.png")
    ).toBe(
      "http://localhost:54196/api/workspaces/workspace%201/file-preview?path=assets%2Ficon%201.png"
    );
  });
});
