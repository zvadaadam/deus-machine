import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../../lib/errors";

// 0.26.1 publishes the bearer in two discovery files and a dashboard link, and passes it
// between modules through process.env. Deus uses a private pipe after listen() instead.
// Apply only to the integrity-checked release in staging. Never write into Bun's hardlinks.
export async function prepareHub(packageDir: string): Promise<void> {
  async function edit(file: string, replacements: [string, string][]) {
    const path = join(packageDir, file);
    let source = await readFile(path, "utf8");
    for (const [from, to] of replacements) {
      if (source.split(from).length !== 2)
        throw new AppError(503, "The installed Device Hub does not match the pinned release.");
      source = source.replace(from, () => to);
    }
    await writeFile(path + ".deus", source);
    await rename(path + ".deus", path);
  }

  const inMemory = 'globalThis[Symbol.for("deus.deviceHubToken")]';
  await edit("dist/server/cli.mjs", [
    ["process.env[SESSION_TOKEN_ENV] = sessionToken;", inMemory + " = sessionToken;"],
    [
      "const handler = hubServer.default;\n  delete process.env[SESSION_TOKEN_ENV];",
      "const handler = hubServer.default;\n  delete " + inMemory + ";",
    ],
    [
      `  withdrawHubState = publishHubState({
    pid: process.pid,
    port,
    url: localHubUrl(options.host, port),
    ...sessionToken ? { token: sessionToken } : {}
  });
  process.once("exit", () => withdrawHubState?.());
  console.log(startupMessage({
    host: options.host,
    port,
    lanAddress: lanAddress(),
    sessionToken,
    ignoredFrameAncestors: sessionToken ? [] : options.frameAncestors
  }));`,
      '  writeFileSync(3, JSON.stringify({ port, token: sessionToken }) + "\\n");',
    ],
  ]);
  await edit("dist/server/index.mjs", [
    ["var SESSION_TOKEN = readSessionToken(process.env);", "var SESSION_TOKEN = " + inMemory + ";"],
    // The dashboard hides never-used devices. The Device picker also boots them.
    ["}).filter((device) => device.lastUsedAt !== undefined),", "}),"],
    ["})).filter((device) => device.booted || device.lastUsedAt !== undefined),", "})),"],
  ]);
  await edit("vendor/serve-sim/dist/middleware.js", [
    ['let Y=bP($,J,X,"127.0.0.1",_);return Q?{...Y,token:Q}:Y', 'return bP($,J,X,"127.0.0.1",_)'],
  ]);
}
