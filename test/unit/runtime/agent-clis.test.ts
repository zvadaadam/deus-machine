import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  AGENT_CLI_TARGETS,
  prepareAgentClis,
  resolveStagedAgentCliPath,
} from "../../../scripts/runtime/agent-clis";

// Real filesystem staging and Electron's resource copier. agent-server's
// installer, offline: the trees `install --dir` lays out, at the versions the
// engine pins.
vi.mock("@zvada/agent-server/server", async () => {
  const { DEFAULT_PINS } = await import("@zvada/agent-server/core");
  return {
    runInstall: async ({ dir, platforms }: { dir: string; platforms: string[] }) => {
      const [platform] = platforms;
      const codex = path.join(dir, "codex", `${DEFAULT_PINS.codex}-${platform}`);
      write(
        path.join(codex, "codex-package.json"),
        JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })
      );
      for (const entry of [
        "bin/codex",
        "bin/codex-code-mode-host",
        "codex-path/rg",
        "codex-resources/zsh/bin/zsh",
        ...(platform?.startsWith("linux-") ? ["codex-resources/bwrap"] : []),
      ]) {
        write(path.join(codex, entry), entry, true);
      }
      const claude = path.join(dir, "claude", `${DEFAULT_PINS.claude}-${platform}`, "claude");
      write(claude, "claude", true);
      return [
        {
          tool: "claude",
          platform,
          cli: { path: claude, source: "cache", version: DEFAULT_PINS.claude },
        },
        {
          tool: "codex",
          platform,
          cli: {
            path: path.join(codex, "bin/codex"),
            source: "cache",
            version: DEFAULT_PINS.codex,
          },
        },
      ];
    },
  };
});

const require = createRequire(import.meta.url);
const { FileMatcher, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
}

async function stage(target: (typeof AGENT_CLI_TARGETS)[number]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-codex-package-"));
  roots.push(root);
  // agent-browser and agent-device are staged from the lockfile; Codex and Claude come from agent-server.
  write(
    path.join(root, "bun.lock"),
    `  "agent-browser": ["agent-browser@0.21.4", "", {}, "sha512-fixture"],\n` +
      `  "agent-device": ["agent-device@0.21.39", "", {}, "sha512-fixture"],`
  );
  write(path.join(root, "node_modules", "agent-device", "bin", "agent-device.mjs"), "");
  write(
    path.join(root, "node_modules", "agent-browser", target.agentBrowserEntry),
    "agent-browser",
    true
  );
  await prepareAgentClis({ projectRoot: root, runtimeKeys: [target.runtimeKey], log: () => {} });
  return {
    root,
    binDir: path.dirname(resolveStagedAgentCliPath(root, target.runtimeKey, "codex")),
  };
}

describe("bundled Codex package", () => {
  it.each(AGENT_CLI_TARGETS)(
    "copies a self-contained package into Electron resources for $runtimeKey",
    async (target) => {
      const { root, binDir } = await stage(target);
      const config = parse(
        readFileSync(new URL("../../../electron-builder.yml", import.meta.url), "utf8")
      );
      const platform = target.runtimeKey.startsWith("darwin-") ? "mac" : "linux";
      const rules = config[platform].extraResources as {
        from: string;
        to: string;
        filter?: string[];
      }[];
      const packaged = path.join(root, "packaged");
      write(path.join(binDir, "index.js.map"), "must not ship");
      // Use the real config and copier: copying aliases individually dereferences
      // them and breaks Codex's resource discovery after the source tree is gone.
      await copyFiles(
        rules
          .filter((rule) => rule.from.includes("${arch}") && rule.to.startsWith("bin"))
          .map(
            (rule) =>
              new FileMatcher(
                path.join(root, rule.from.replace("${arch}", target.runtimeKey.split("-")[1])),
                path.join(packaged, rule.to),
                (pattern: string) => pattern,
                rule.filter
              )
          )
      );
      rmSync(binDir, { recursive: true });
      const payload = path.join(packaged, "bin/codex-runtime");
      expect(realpathSync(path.join(packaged, "bin/codex"))).toBe(
        realpathSync(path.join(payload, "bin/codex"))
      );
      expect(readFileSync(path.join(payload, "bin/codex-code-mode-host"), "utf8")).toBe(
        "bin/codex-code-mode-host"
      );
      expect(existsSync(path.join(payload, "codex-package.json"))).toBe(true);
      expect(existsSync(path.join(payload, "codex-resources/zsh/bin/zsh"))).toBe(true);
      if (platform === "linux")
        expect(existsSync(path.join(payload, "codex-resources/bwrap"))).toBe(true);
      expect(existsSync(path.join(packaged, "bin/index.js.map"))).toBe(false);
    }
  );
});
