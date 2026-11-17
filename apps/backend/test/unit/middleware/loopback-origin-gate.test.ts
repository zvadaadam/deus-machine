import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createLoopbackOriginGate,
  FOREIGN_PAGE,
  refuseLoopbackRequest,
  WRONG_HOST,
} from "../../../src/middleware/loopback-origin-gate";
import { isListedOrigin, parseWebOrigins } from "@shared/web-origins";

const OWN_PORT = 51000;
const listed = parseWebOrigins("app://deus, http://localhost:*,http://127.0.0.1:*").origins;

describe("parseWebOrigins", () => {
  it("reads nothing from an empty or missing value", () => {
    expect(parseWebOrigins(undefined)).toEqual({ origins: [], invalid: [] });
    expect(parseWebOrigins("")).toEqual({ origins: [], invalid: [] });
    expect(parseWebOrigins(" , ,")).toEqual({ origins: [], invalid: [] });
  });

  it("reads exact origins, a port wildcard and IPv6, case-insensitively", () => {
    expect(
      parseWebOrigins("app://deus,HTTP://LocalHost:1420, http://127.0.0.1:*,http://[::1]:*")
    ).toEqual({
      origins: [
        { scheme: "app", host: "deus", port: null },
        { scheme: "http", host: "localhost", port: "1420" },
        { scheme: "http", host: "127.0.0.1", port: "*" },
        { scheme: "http", host: "[::1]", port: "*" },
      ],
      invalid: [],
    });
  });

  it("leaves out and names what is not an origin, and never lists null or file://", () => {
    const { origins, invalid } = parseWebOrigins(
      "null,file://,file:///Users,http://localhost:1420/,http://localhost:1420/app,*,http://*:1420,http://localhost:99999,localhost:1420,http://user@localhost,app://deus"
    );
    expect(origins).toEqual([{ scheme: "app", host: "deus", port: null }]);
    expect(invalid).toEqual([
      "null",
      "file://",
      "file:///Users",
      "http://localhost:1420/",
      "http://localhost:1420/app",
      "*",
      "http://*:1420",
      "http://localhost:99999",
      "localhost:1420",
      "http://user@localhost",
    ]);
  });
});

describe("isListedOrigin", () => {
  const exact = parseWebOrigins("http://localhost:1420,app://deus").origins;
  it.each([
    ["http://localhost:1420", exact, true],
    ["http://localhost:1421", exact, false],
    ["http://localhost", exact, false],
    ["https://localhost:1420", exact, false],
    ["app://deus", exact, true],
    ["app://deus:80", exact, false],
    ["app://deus.evil", exact, false],
    ["http://localhost:51234", listed, true],
    // The wildcard covers a default port, which browsers leave out.
    ["http://localhost", listed, true],
    ["http://127.0.0.1:1420", listed, true],
    ["http://[::1]:1420", listed, false],
    ["http://localhost.evil.example:1420", listed, false],
    // A request cannot claim the wildcard itself.
    ["http://localhost:*", listed, false],
    ["null", listed, false],
    ["file://", listed, false],
    ["", listed, false],
    ["http://localhost:1420/", listed, false],
  ])("%s", (origin, patterns, expected) => {
    expect(isListedOrigin(origin, patterns)).toBe(expected);
  });
});

describe("refuseLoopbackRequest", () => {
  it.each([
    // [host, origin, refusal]
    // The app's own window, Vite in dev, the CLI, curl, the desktop main process.
    ["127.0.0.1:51000", "app://deus", null],
    ["localhost:51000", "http://localhost:1420", null],
    ["localhost:51000", "http://127.0.0.1:61234", null],
    ["127.0.0.1:51000", undefined, null],
    ["localhost", undefined, null],
    ["LOCALHOST:51000", undefined, null],
    ["[::1]:51000", undefined, null],
    // Foreign pages: another site, a sandboxed frame, a local file.
    ["127.0.0.1:51000", "https://evil.example", FOREIGN_PAGE],
    ["127.0.0.1:51000", "null", FOREIGN_PAGE],
    ["127.0.0.1:51000", "file://", FOREIGN_PAGE],
    ["127.0.0.1:51000", "", FOREIGN_PAGE],
    ["127.0.0.1:51000", "http://localhost:1420/path", FOREIGN_PAGE],
    ["127.0.0.1:51000", "app://deus.evil", FOREIGN_PAGE],
    // A page the backend serves itself is not trusted, though the wildcard covers it.
    ["127.0.0.1:51000", "http://127.0.0.1:51000", FOREIGN_PAGE],
    ["127.0.0.1:51000", "http://localhost:51000", FOREIGN_PAGE],
    // DNS rebinding: a name that resolves here is still not this computer.
    ["evil.example:51000", undefined, WRONG_HOST],
    ["evil.example:51000", "app://deus", WRONG_HOST],
    ["localhost.evil.example:51000", undefined, WRONG_HOST],
    ["127.0.0.2:51000", undefined, WRONG_HOST],
    ["0.0.0.0:51000", undefined, WRONG_HOST],
    ["[::ffff:127.0.0.1]:51000", undefined, WRONG_HOST],
    ["localhost:51000:1", undefined, WRONG_HOST],
    ["localhost:abc", undefined, WRONG_HOST],
    ["local host", undefined, WRONG_HOST],
    ["", undefined, WRONG_HOST],
    [undefined, undefined, WRONG_HOST],
  ])("Host %j, Origin %j", (host, origin, refusal) => {
    expect(refuseLoopbackRequest({ host, origin, ownPort: OWN_PORT }, listed)).toBe(refusal);
  });

  it("refuses its own origin on a default port, which a browser leaves out", () => {
    for (const [origin, ownPort] of [
      ["http://localhost", 80],
      ["http://127.0.0.1", 80],
      ["https://localhost", 443],
    ] as const) {
      expect(refuseLoopbackRequest({ host: "localhost", origin, ownPort }, listed)).toBe(
        FOREIGN_PAGE
      );
    }
    // The same origin is another server's when this backend is on another port.
    expect(
      refuseLoopbackRequest(
        { host: "localhost:51000", origin: "http://localhost", ownPort: 51000 },
        listed
      )
    ).toBeNull();
  });

  it("trusts no origin when the launcher listed none", () => {
    expect(refuseLoopbackRequest({ host: "localhost:1", origin: "app://deus" }, [])).toBe(
      FOREIGN_PAGE
    );
    expect(refuseLoopbackRequest({ host: "localhost:1", origin: undefined }, [])).toBeNull();
  });
});

describe("the gate as middleware", () => {
  let handled = 0;
  const app = new Hono();
  app.use("*", createLoopbackOriginGate(listed));
  app.all("*", (c) => {
    handled++;
    return c.json({ ok: true });
  });

  const ask = (remoteAddress: string, headers: Record<string, string>) =>
    app.request(
      "http://localhost/api/settings",
      { method: "POST", headers },
      {
        incoming: { socket: { remoteAddress, localPort: OWN_PORT } },
      }
    );

  it("refuses a foreign page on loopback before any handler, in a plain sentence", async () => {
    handled = 0;
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await ask(address, { host: "127.0.0.1:51000", origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: FOREIGN_PAGE });
    }
    const rebound = await ask("127.0.0.1", { host: "evil.example:51000" });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toEqual({ error: WRONG_HOST });
    expect(handled).toBe(0);
  });

  it("lets the app and pageless callers through", async () => {
    handled = 0;
    expect((await ask("127.0.0.1", { host: "127.0.0.1:51000", origin: "app://deus" })).status).toBe(
      200
    );
    expect((await ask("127.0.0.1", { host: "localhost:51000" })).status).toBe(200);
    expect(handled).toBe(2);
  });

  it("leaves requests from other addresses to their token checks", async () => {
    handled = 0;
    const res = await ask("192.168.1.50", {
      host: "192.168.1.20:51000",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(200);
    expect(handled).toBe(1);
  });
});
