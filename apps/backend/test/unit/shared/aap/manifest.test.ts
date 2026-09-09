import { describe, expect, it } from "vitest";

import {
  idToServerName,
  ManifestSchema,
  parseManifest,
  safeParseManifest,
} from "@shared/aap/manifest";

/** Minimal valid manifest — modelled after packages/device-use/agentic-app.json. */
const VALID_MANIFEST = {
  $schema: "https://agenticapps.dev/schema/v1.json",
  protocolVersion: "1",
  id: "deus.mobile-use",
  name: "Mobile Use",
  description: "iOS simulator workbench.",
  version: "0.1.0",
  launch: {
    command: "device-use",
    args: ["serve", "--port", "{port}"],
    cwd: "{workspace}",
    env: { DEUS_STORAGE: "{storage.workspace}" },
    ready: { type: "http", path: "/health", timeoutMs: 30_000 },
  },
  ui: { url: "http://127.0.0.1:{port}/" },
  agent: { tools: { type: "mcp-http", url: "http://127.0.0.1:{port}/mcp" } },
  storage: { workspace: "{workspace}/.device-use" },
  lifecycle: { scope: "workspace", stopTimeoutMs: 5_000 },
  requires: [
    { type: "cli", name: "xcrun", install: "Install Xcode from the App Store" },
    { type: "platform", os: "darwin" },
  ],
};

describe("shared/aap/manifest", () => {
  describe("parseManifest", () => {
    it("parses a valid manifest", () => {
      const manifest = parseManifest(VALID_MANIFEST);
      expect(manifest.id).toBe("deus.mobile-use");
      expect(manifest.name).toBe("Mobile Use");
      expect(manifest.launch.command).toBe("device-use");
      expect(manifest.launch.args).toEqual(["serve", "--port", "{port}"]);
    });

    it("applies defaults", () => {
      const manifest = parseManifest({
        protocolVersion: "1",
        id: "deus.minimal",
        name: "Minimal",
        description: "Minimal example.",
        version: "0.0.1",
        launch: { command: "noop" },
        ui: { url: "http://127.0.0.1/" },
        agent: { tools: { type: "mcp-http", url: "http://127.0.0.1/mcp" } },
      });
      // launch defaults
      expect(manifest.launch.args).toEqual([]);
      expect(manifest.launch.env).toEqual({});
      expect(manifest.launch.ready).toEqual({ type: "tcp", timeoutMs: 30_000 });
      // storage defaults to empty object
      expect(manifest.storage).toEqual({});
      // lifecycle defaults
      expect(manifest.lifecycle.scope).toBe("workspace");
      expect(manifest.lifecycle.stopTimeoutMs).toBe(5_000);
      // requires defaults to empty array
      expect(manifest.requires).toEqual([]);
    });

    it("rejects missing required field", () => {
      const { name: _name, ...withoutName } = VALID_MANIFEST;
      expect(() => parseManifest(withoutName)).toThrow();
    });

    it("requires protocolVersion (no silent v1 stamp)", () => {
      const { protocolVersion: _pv, ...withoutVersion } = VALID_MANIFEST;
      expect(() => parseManifest(withoutVersion)).toThrow();
    });

    it("rejects unknown protocolVersion (v1 host only understands v1)", () => {
      expect(() => parseManifest({ ...VALID_MANIFEST, protocolVersion: "2" })).toThrow();
    });

    it("rejects invalid id (uppercase)", () => {
      expect(() => parseManifest({ ...VALID_MANIFEST, id: "Deus.Mobile-Use" })).toThrow();
    });

    it("rejects invalid id (no dot or dash)", () => {
      expect(() => parseManifest({ ...VALID_MANIFEST, id: "deus" })).toThrow();
    });

    it("rejects non-mcp-http agent.tools.type", () => {
      const stdio = safeParseManifest({
        ...VALID_MANIFEST,
        agent: { tools: { type: "mcp-stdio", command: "my-tool" } },
      });
      expect(stdio.success).toBe(false);

      const cli = safeParseManifest({ ...VALID_MANIFEST, agent: { tools: { type: "cli" } } });
      expect(cli.success).toBe(false);
    });

    it("discriminates ready probe variants (http, tcp)", () => {
      const tcp = parseManifest({
        ...VALID_MANIFEST,
        launch: { ...VALID_MANIFEST.launch, ready: { type: "tcp" } },
      });
      expect(tcp.launch.ready.type).toBe("tcp");
    });

    it("rejects unsupported ready probe types", () => {
      const stdout = safeParseManifest({
        ...VALID_MANIFEST,
        launch: { ...VALID_MANIFEST.launch, ready: { type: "stdout-pattern", pattern: "ready" } },
      });
      expect(stdout.success).toBe(false);
    });

    it("validates requires entries (cli, platform)", () => {
      const manifest = parseManifest({
        ...VALID_MANIFEST,
        requires: [
          { type: "cli", name: "git" },
          { type: "platform", os: "darwin", arch: "arm64" },
        ],
      });
      expect(manifest.requires).toHaveLength(2);
    });

    it("rejects requires types outside v1 (env, port)", () => {
      const env = safeParseManifest({
        ...VALID_MANIFEST,
        requires: [{ type: "env", name: "HOME" }],
      });
      expect(env.success).toBe(false);

      const port = safeParseManifest({
        ...VALID_MANIFEST,
        requires: [{ type: "port", port: 5432 }],
      });
      expect(port.success).toBe(false);
    });

    it("silently strips unknown top-level fields (forward-compat)", () => {
      // Manifests that declare v2-or-later fields (commands, events,
      // capabilities, …) should still parse cleanly on a v1 host — the
      // unknown fields just don't appear on the parsed object.
      const manifest = parseManifest({
        ...VALID_MANIFEST,
        commands: [{ name: "snapshot", path: "/commands/snapshot" }],
        events: { channel: "ws", url: "ws://127.0.0.1:{port}/events" },
        capabilities: ["filesystem:workspace"],
      });
      expect((manifest as unknown as { commands?: unknown }).commands).toBeUndefined();
      expect((manifest as unknown as { events?: unknown }).events).toBeUndefined();
      expect((manifest as unknown as { capabilities?: unknown }).capabilities).toBeUndefined();
    });
  });

  describe("idToServerName", () => {
    it("replaces dots and dashes with underscores", () => {
      expect(idToServerName("deus.mobile-use")).toBe("deus_mobile_use");
    });

    it("handles multi-segment ids", () => {
      expect(idToServerName("com.vendor.my-app")).toBe("com_vendor_my_app");
    });
  });

  describe("ManifestSchema export", () => {
    it("exposes the raw Zod schema for consumers that want safeParse / refinements", () => {
      const result = ManifestSchema.safeParse(VALID_MANIFEST);
      expect(result.success).toBe(true);
    });
  });
});
