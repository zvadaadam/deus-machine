#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const env = process.env;
if (env.BUN_BE_BUN !== "1") process.exit(20);

if (process.argv[2] === "install") {
  if (!process.argv.includes("--frozen-lockfile") || !existsSync("bun.lock")) process.exit(21);
  appendFileSync(join(process.cwd(), "..", "install-count"), "1");
  if (env.FIXTURE_OFFLINE) {
    console.error("Could not download package\nregistry connection timed out");
    process.exit(1);
  }
  while (env.DEUS_TEST_DEVICE_INSTALL_GATE && !existsSync(env.DEUS_TEST_DEVICE_INSTALL_GATE))
    await delay(50);
  const pkg = "node_modules/expo-device-hub";
  const version = JSON.parse(readFileSync("package.json", "utf8")).dependencies["expo-device-hub"];
  mkdirSync(join(pkg, "dist/server"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(pkg, "dist/server/cli.mjs"), "");
} else if (process.argv[2] === "--monitor") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(env.EXPO_DEVICE_HUB_STATE_DIR, "monitor"), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const directory = env.EXPO_DEVICE_HUB_STATE_DIR;
  if (
    !process.argv.includes("--require-token") ||
    process.argv[process.argv.indexOf("--host") + 1] !== "127.0.0.1"
  )
    process.exit(22);
  if (
    (statSync(directory).mode & 0o777) !== 0o700 ||
    (statSync(env.SERVE_SIM_STATE_DIR).mode & 0o777) !== 0o700 ||
    readdirSync(directory).length
  )
    process.exit(23);
  process.on("SIGTERM", () => {
    if (!env.FIXTURE_STUCK) process.exit(0);
  });
  writeFileSync(join(directory, "pid"), String(process.pid));
  writeFileSync(join(directory, "path"), env.PATH);
  if (env.FIXTURE_BROKEN) {
    unlinkSync(process.argv[2]);
    process.exit(24);
  }
  if (env.FIXTURE_MONITOR)
    spawn(process.execPath, [import.meta.filename, "--monitor"], { stdio: "ignore" });
  function publish(port, pid) {
    writeFileSync(
      join(directory, `server-${port}.json`),
      JSON.stringify({
        pid,
        port,
        url: `http://127.0.0.1:${port}`,
        token: randomUUID(),
      }),
      { mode: 0o600 }
    );
  }
  const server = createServer((_request, response) =>
    response.end(JSON.stringify({ simulators: [], emulators: [], errors: [] }))
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  publish(1, process.pid + 1);
  if (!env.FIXTURE_NO_DISCOVERY) publish(server.address().port, process.pid);
}
