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
  validateStagedAgentClis,
} from "../../../scripts/runtime/agent-clis";

// Keep real filesystem staging and Electron's resource copier. Only `file`
// inspection is replaced so the fixtures can exercise every target on any host.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: (command: string, args: string[]) => {
      if (command !== "file") throw new Error(`Unexpected command: ${command}`);
      const file = args.at(-1)!;
      const target = AGENT_CLI_TARGETS.find((t) => file.includes(t.runtimeKey))!;
      return `${file}: ${target.fileFormat} ${target.fileArch}`;
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
  const packages = [target.codexAliasPackage, target.claudePackageName, "agent-browser"];
  write(
    path.join(root, "bun.lock"),
    packages.map((name) => `  "${name}": ["${name}@0.153.4", "", {}, "sha512-fixture"],`).join("\n")
  );
  const vendor = path.join(
    root,
    "node_modules",
    target.codexAliasPackage,
    "vendor",
    target.codexTriple
  );
  write(
    path.join(vendor, "codex-package.json"),
    JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })
  );
  for (const entry of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
    ...(target.runtimeKey.startsWith("linux-") ? ["codex-resources/bwrap"] : []),
  ]) {
    write(path.join(vendor, entry), entry, true);
  }
  write(path.join(root, "node_modules", target.claudePackageName, "claude"), "claude", true);
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
    "keeps helpers beside Codex and validates them for $runtimeKey",
    async (target) => {
      const { root, binDir } = await stage(target);
      const executable = realpathSync(path.join(binDir, "codex"));
      expect(executable).toBe(realpathSync(path.join(binDir, "codex-runtime/bin/codex")));
      const helper = path.join(path.dirname(executable), "codex-code-mode-host");
      expect(readFileSync(helper, "utf8")).toBe("bin/codex-code-mode-host");
      expect(
        readFileSync(path.join(path.dirname(executable), "../codex-resources/zsh/bin/zsh"), "utf8")
      ).toBe("codex-resources/zsh/bin/zsh");
      const validate = () =>
        validateStagedAgentClis({
          projectRoot: root,
          runtimeKey: target.runtimeKey,
          log: () => {},
        });
      expect(validate).not.toThrow();
      rmSync(helper);
      expect(validate).toThrow("codex-code-mode-host");
    }
  );

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
