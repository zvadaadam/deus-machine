import { spawnSync } from "node:child_process";

const desktopSmoke = "bun run smoke:packaged-desktop";
export const groups = {
  quality: [
    "bun run lint",
    "bun run knip",
    "bun run format:check",
    "bun run typecheck:all",
    "bun run test:relay",
    "bun run test:screen-studio",
    "VITE_CLOUD_DIRECT=1 bun run build:web",
  ],
  app: [
    "bun run native:node",
    "bun run test:runtime-client",
    "bun run test:app",
    "bun test/e2e/workspace-usability.browser.mjs",
    "bun test/e2e/workspace-layout.browser.mjs",
    "bun test/e2e/controls.browser.mjs",
    "bun test/e2e/provider-accounts.browser.mjs",
    "bun test/e2e/model-picker.browser.mjs",
    "node test/e2e/query-protocol-hmr.browser.mjs",
    "node test/e2e/chat-scroll.browser.mjs",
  ],
  journeys: [
    "bun run native:node",
    "node --import tsx test/e2e/transcript-order.browser.mjs",
    "node --import tsx test/e2e/composer-drafts.browser.mjs",
    "node --import tsx test/e2e/workspace-list.browser.mjs",
    "node --import tsx test/e2e/queued-messages.browser.mjs",
    "node --import tsx test/e2e/usage-limit.browser.mjs",
    "bun run test:e2e:workspace-start",
    "bun run test:e2e:cloud",
  ],
  backend: ["bun run test:backend"],
  "agent-server": ["bun run test:agent-server"],
  "runtime-macos": [
    "bun run test:bun",
    "bun run build:runtime",
    "bun run build",
    "bun run package:mac:dir",
    "bun run smoke:packaged-runtime",
    desktopSmoke,
    "bun run smoke:cli-package",
  ],
  "runtime-linux": [
    "bun run test:bun",
    "bun run build:all",
    "bunx electron-builder --linux dir --publish never",
    "bun run smoke:packaged-runtime -- --app dist-electron/linux-unpacked/resources",
    "bun run smoke:cli-package",
  ],
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !Object.hasOwn(groups, args[0]))) {
    console.error(`Usage: bun run check [${Object.keys(groups).join(" | ")}]`);
    process.exit(1);
  }

  const actions = process.env.GITHUB_ACTIONS === "true";
  const results = [];
  for (const name of args.length ? args : Object.keys(groups)) {
    if (
      (name === "runtime-macos" && process.platform !== "darwin") ||
      (name === "runtime-linux" && (process.platform !== "linux" || process.arch !== "x64"))
    ) {
      results.push({ command: name, result: "skip (other platform)", seconds: 0 });
      if (args.length) process.exitCode = 1;
      continue;
    }
    for (const command of groups[name]) {
      if (command === desktopSmoke && !actions) {
        results.push({ command, result: "skip (opens a window)", seconds: 0 });
        continue;
      }
      console.log(actions ? `::group::${command}` : `\n$ ${command}`);
      const start = performance.now();
      const { status } = spawnSync(command, { shell: true, stdio: "inherit" });
      if (actions) console.log("::endgroup::");
      results.push({
        command,
        result: status === 0 ? "pass" : "fail",
        seconds: ((performance.now() - start) / 1000).toFixed(1),
      });
      if (status !== 0) process.exitCode = 1;
    }
  }
  console.table(results);
}
