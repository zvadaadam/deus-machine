/* global Bun */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { configureBackendEnv } from "../../runtime-env.ts";
import { checkCatalog } from "../../src/services/agent/gateway.ts";

// Run with Bun. A fresh backend process inherits the proxy, as the installed app does.
if (process.argv[2] === "backend") {
  configureBackendEnv();
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const hosts = process.env[name].split(",");
    for (const host of ["upper.invalid", "lower.invalid", "localhost", "127.0.0.1", "::1", "[::1]"])
      assert.ok(hosts.includes(host), host);
  }
  const { SessionRelay } = await import(
    new URL(
      "../../src/core/gateway/session-relay.ts",
      import.meta.resolve("@zvada/agent-server/core")
    )
  );
  const { resolveLogin } = await import(
    new URL("../../src/core/agents/credentials.ts", import.meta.resolve("@zvada/agent-server/core"))
  );
  const { baseUrl, key } = JSON.parse(await Bun.stdin.text());
  assert.equal((await fetch("http://positive-control.invalid/test")).status, 204);
  await checkCatalog({
    baseUrl,
    apiKey: key,
    preset: "custom",
    formats: ["messages", "responses"],
  });
  for (const [harness, format, path] of [
    ["claude-code", "messages", "/v1/messages"],
    ["codex-app-server", "responses", "/responses"],
  ]) {
    const relay = new SessionRelay(format);
    try {
      const sessionId = crypto.randomUUID();
      const login = await resolveLogin(harness, {
        sessionId,
        turnId: crypto.randomUUID(),
        relay,
        signal: AbortSignal.timeout(5000),
        credentials: () => ({
          type: "api_key",
          apiKey: key,
          baseUrl: baseUrl + (format === "responses" ? "/v1" : ""),
          binding: { ref: "fixture", revision: "1", format },
        }),
      });
      assert.equal(login.type, "relay");
      const response = await fetch(login.relayUrl + path, {
        method: "POST",
        body: "{}",
        headers: {
          [format === "messages" ? "x-api-key" : "authorization"]:
            format === "messages" ? login.placeholderKey : "Bearer " + login.placeholderKey,
        },
      });
      assert.equal(response.status, 200);
      await response.text();
    } finally {
      await relay.close();
    }
  }
} else {
  const key = crypto.randomUUID();
  const received = [],
    unexpected = [];
  let control = 0;
  const gateways = ["127.0.0.1", "::1"].map((hostname) =>
    Bun.serve({
      hostname,
      port: 0,
      fetch(request) {
        const { pathname, hostname } = new URL(request.url);
        const authorized =
          pathname === "/v1/messages"
            ? request.headers.get("x-api-key") === key
            : request.headers.get("authorization") === "Bearer " + key;
        if (authorized) received.push(hostname + pathname);
        return Response.json({ data: [] }, { status: authorized ? 200 : 403 });
      },
    })
  );
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).hostname === "positive-control.invalid") control++;
      else unexpected.push(request.method);
      return new Response(null, { status: 204 });
    },
  });
  const url = proxy.url.origin;
  try {
    for (const gateway of gateways) {
      const child = spawn(process.execPath, ["--no-env-file", import.meta.filename, "backend"], {
        env: {
          ...process.env,
          HTTP_PROXY: url,
          HTTPS_PROXY: url,
          http_proxy: url,
          https_proxy: url,
          NO_PROXY: "upper.invalid",
          no_proxy: "lower.invalid",
        },
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.end(JSON.stringify({ baseUrl: gateway.url.origin, key }));
      assert.equal((await once(child, "exit"))[0], 0);
    }
    assert.equal(unexpected.length, 0);
    assert.equal(control, 2);
    console.log(
      JSON.stringify({
        bun: Bun.version,
        authorized: received,
        unexpectedProxyRequests: unexpected.length,
        proxyControl: control,
      })
    );
  } finally {
    await proxy.stop(true);
    for (const gateway of gateways) await gateway.stop(true);
  }
}
