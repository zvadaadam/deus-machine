import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  RELAY_PROTOCOL,
  TICKET_AUDIENCE,
  TICKET_ISSUER,
  TICKET_TYPE,
  ticketFromProtocols,
  verifyTicket,
} from "../src/tickets";
import {
  createMockWebSocket,
  createTestDO,
  getSentMessages,
  registerServer,
  type MockDOState,
  type MockWebSocket,
} from "./mocks";

const MACHINE = "0123456789abcdef";
let privateKey: CryptoKey;
let jwks: string;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  jwks = JSON.stringify({ keys: [publicJwk] });
});

interface TicketOptions {
  sub?: string;
  mid?: string;
  role?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  aud?: string;
  typ?: string;
  key?: CryptoKey;
}

function ticket(options: TicketOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ mid: options.mid ?? MACHINE, role: options.role ?? "client" })
    .setProtectedHeader({ alg: "ES256", typ: options.typ ?? TICKET_TYPE, kid: "k1" })
    .setIssuer(TICKET_ISSUER)
    .setAudience(options.aud ?? TICKET_AUDIENCE)
    .setSubject(options.sub ?? "user_owner")
    .setJti(options.jti ?? crypto.randomUUID())
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 60)
    .sign(options.key ?? privateKey);
}

describe("ticket verification", () => {
  it("accepts a fresh Deus Cloud ticket and returns its binding", async () => {
    const admission = await verifyTicket(jwks, await ticket({ role: "host", jti: "t-1" }));
    expect(admission).toEqual({
      accountId: "user_owner",
      machineId: MACHINE,
      role: "host",
      ticketId: "t-1",
      expiresAt: expect.any(Number),
    });
  });

  it.each([
    [
      "expired",
      { exp: Math.floor(Date.now() / 1000) - 1, iat: Math.floor(Date.now() / 1000) - 61 },
    ],
    ["for another audience", { aud: "agnt-backend" }],
    ["of another token type", { typ: "JWT" }],
    ["for an invalid machine id", { mid: "abc123" }],
    ["for an unknown role", { role: "admin" }],
    ["issued in the future", { iat: Math.floor(Date.now() / 1000) + 120 }],
    [
      "living longer than a dial needs",
      { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
    ],
  ])("rejects a ticket %s", async (_label, options) => {
    await expect(verifyTicket(jwks, await ticket(options as TicketOptions))).rejects.toThrow();
  });

  it("rejects a ticket signed by another key and any HS256 token", async () => {
    const other = await generateKeyPair("ES256");
    await expect(verifyTicket(jwks, await ticket({ key: other.privateKey }))).rejects.toThrow();
    const hs256 = await new SignJWT({ mid: MACHINE, role: "client" })
      .setProtectedHeader({ alg: "HS256", typ: TICKET_TYPE })
      .setIssuer(TICKET_ISSUER)
      .setAudience(TICKET_AUDIENCE)
      .setSubject("user_owner")
      .setJti("x")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode("shared-secret"));
    await expect(verifyTicket(jwks, hs256)).rejects.toThrow();
  });

  it("fails closed without keys and on malformed keys or oversized tickets", async () => {
    const valid = await ticket();
    await expect(verifyTicket(undefined, valid)).rejects.toThrow("not configured");
    await expect(verifyTicket("{not json", valid)).rejects.toThrow("misconfigured");
    await expect(verifyTicket(jwks, "x".repeat(5000))).rejects.toThrow("too large");
  });

  it("accepts either key while a rotation lists both", async () => {
    const next = await generateKeyPair("ES256");
    const nextJwk: JWK = { ...(await exportJWK(next.publicKey)), kid: "k2", alg: "ES256" };
    const both = JSON.stringify({ keys: [...JSON.parse(jwks).keys, nextJwk] });
    const oldTicket = await ticket({ jti: "old-key" });
    const newTicket = await new SignJWT({ mid: MACHINE, role: "client" })
      .setProtectedHeader({ alg: "ES256", typ: TICKET_TYPE, kid: "k2" })
      .setIssuer(TICKET_ISSUER)
      .setAudience(TICKET_AUDIENCE)
      .setSubject("user_owner")
      .setJti("new-key")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(next.privateKey);
    expect((await verifyTicket(both, oldTicket)).ticketId).toBe("old-key");
    expect((await verifyTicket(both, newTicket)).ticketId).toBe("new-key");
    // Once the old key is removed, its tickets stop working.
    await expect(
      verifyTicket(JSON.stringify({ keys: [nextJwk] }), await ticket({ jti: "retired" }))
    ).rejects.toThrow();
  });

  it("reads the ticket only from the relay subprotocol pair", () => {
    expect(ticketFromProtocols(`${RELAY_PROTOCOL}, abc.def.ghi`)).toBe("abc.def.ghi");
    expect(ticketFromProtocols("abc.def.ghi")).toBeNull();
    expect(ticketFromProtocols(`other.v1, abc.def.ghi`)).toBeNull();
    expect(ticketFromProtocols(`${RELAY_PROTOCOL}, a, b`)).toBeNull();
    expect(ticketFromProtocols(null)).toBeNull();
  });
});

describe("Worker admission", () => {
  async function worker() {
    vi.resetModules();
    vi.doMock("cloudflare:workers", () => ({ DurableObject: class {} }));
    const { default: app } = await import("../src/index");
    const forwarded: Request[] = [];
    const env = {
      ENVIRONMENT: "test",
      RELAY_TICKET_JWKS: jwks,
      RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            forwarded.push(request);
            return new Response("upgraded");
          },
        }),
      },
    };
    const request = (path: string, protocols?: string, headers: Record<string, string> = {}) =>
      app.request(
        path,
        {
          headers: {
            upgrade: "websocket",
            ...(protocols ? { "sec-websocket-protocol": protocols } : {}),
            ...headers,
          },
        },
        env
      );
    return { request, forwarded };
  }

  it("forwards a verified ticket's binding and overwrites a forged one", async () => {
    const { request, forwarded } = await worker();
    const response = await request(
      `/api/servers/${MACHINE}/connect`,
      `${RELAY_PROTOCOL}, ${await ticket({ jti: "real" })}`,
      { "x-deus-relay-admission": JSON.stringify({ accountId: "user_attacker" }) }
    );
    expect(await response.text()).toBe("upgraded");
    expect(new URL(forwarded[0].url).pathname).toBe("/connect");
    expect(JSON.parse(forwarded[0].headers.get("x-deus-relay-admission")!)).toMatchObject({
      accountId: "user_owner",
      machineId: MACHINE,
      role: "client",
      ticketId: "real",
    });
  });

  it("refuses sockets without a valid ticket for this machine and endpoint", async () => {
    const { request, forwarded } = await worker();
    expect((await request(`/api/servers/${MACHINE}/connect`)).status).toBe(401);
    expect(
      (await request(`/api/servers/${MACHINE}/connect`, `${RELAY_PROTOCOL}, garbage`)).status
    ).toBe(401);
    const other = await ticket({ mid: "fedcba9876543210" });
    expect(
      (await request(`/api/servers/${MACHINE}/connect`, `${RELAY_PROTOCOL}, ${other}`)).status
    ).toBe(403);
    // A client ticket cannot open the host's tunnel.
    const client = await ticket({ role: "client" });
    expect(
      (await request(`/api/servers/${MACHINE}/tunnel`, `${RELAY_PROTOCOL}, ${client}`)).status
    ).toBe(403);
    expect((await request(`/api/servers/short/connect`)).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it("serves no public machine status", async () => {
    const { request } = await worker();
    expect((await request(`/api/servers/${MACHINE}/status`)).status).toBe(404);
  });
});

describe("Durable Object admission", () => {
  let relay: any;
  let state: MockDOState;
  let accepted: MockWebSocket[];

  beforeEach(async () => {
    vi.resetModules();
    ({ relay, state } = await createTestDO());
    accepted = [];
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0: MockWebSocket;
        1: MockWebSocket;
        constructor() {
          this[0] = createMockWebSocket([], null);
          this[1] = createMockWebSocket([], null);
          accepted.push(this[1]);
        }
      }
    );
    // Node's Response cannot carry a 101; the upgrade itself is the Worker runtime's.
    relay.upgraded = () => new Response(null, { status: 200 });
  });

  const admit = (
    path: "/tunnel" | "/connect" | "/pair",
    claims: Partial<{ accountId: string; role: string; ticketId: string; expiresAt: number }> = {}
  ) =>
    relay.fetch(
      new Request(`https://relay.internal${path}`, {
        headers: {
          "x-deus-relay-admission": JSON.stringify({
            accountId: "user_owner",
            machineId: MACHINE,
            role: path === "/tunnel" ? "host" : "client",
            ticketId: crypto.randomUUID(),
            expiresAt: Date.now() + 60_000,
            ...claims,
          }),
        },
      })
    );

  it("pins the machine to its first host's account", async () => {
    expect((await admit("/tunnel")).status).toBe(200);
    expect(state.storage._data.get("owner")).toBe("user_owner");
    expect(accepted[0].deserializeAttachment()).toEqual({ accountId: "user_owner", role: "host" });

    expect((await admit("/tunnel", { accountId: "user_other" })).status).toBe(403);
    expect((await admit("/connect", { accountId: "user_other" })).status).toBe(403);
    expect((await admit("/connect")).status).toBe(200);
  });

  it("refuses viewers of a machine no host has claimed", async () => {
    expect((await admit("/connect")).status).toBe(503);
    expect(state.storage._data.has("owner")).toBe(false);
  });

  it("tells a pairer the computer is offline on the socket, which a browser can read", async () => {
    await admit("/tunnel"); // Claimed, but its tunnel never registered: the Mac is away.
    expect((await admit("/pair")).status).toBe(200);
    const pairer = accepted.at(-1)!;
    expect(pairer.accept).toHaveBeenCalled();
    expect(pairer._sentMessages).toEqual([
      {
        type: "pair_failed",
        message: "This computer is offline. Open Deus on it, then try again.",
      },
    ]);
    expect(pairer.close).toHaveBeenCalledWith(1000, "Computer offline");
    expect([...state.storage._data.keys()].some((key) => key.startsWith("pending:pair:"))).toBe(
      false
    );
  });

  it("consumes each ticket once and forgets it after expiry", async () => {
    await admit("/tunnel");
    const expiresAt = Date.now() + 60_000;
    expect((await admit("/connect", { ticketId: "once", expiresAt })).status).toBe(200);
    expect((await admit("/connect", { ticketId: "once", expiresAt })).status).toBe(401);
    // Remembered a minute past expiry, so a skewed clock cannot reopen it.
    expect(state.storage._data.get("ticket:once")).toBe(expiresAt + 60_000);

    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    await relay.alarm();
    expect(state.storage._data.has("ticket:once")).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 60_001);
    await relay.alarm();
    expect(state.storage._data.has("ticket:once")).toBe(false);
  });

  it("requires the Worker's admission header with a matching role", async () => {
    const bare = await relay.fetch(new Request("https://relay.internal/connect"));
    expect(bare.status).toBe(401);
    expect((await admit("/tunnel", { role: "client" })).status).toBe(401);
    expect((await admit("/connect", { role: "host" })).status).toBe(401);
  });

  it("tells the host which account each viewer and pairer was admitted for", async () => {
    const tunnelWs = await registerServer(relay, state);
    await admit("/connect");
    const clientWs = accepted.at(-1)!;
    const clientId = state.getTags(clientWs).find((tag) => tag !== "client")!;
    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "authenticate", token: "grant" })
    );

    await admit("/pair");
    const pairerWs = accepted.at(-1)!;
    await relay.webSocketMessage(
      pairerWs,
      JSON.stringify({ type: "pair_request", code: "SOFT TIGER", deviceName: "Phone" })
    );

    expect(getSentMessages(tunnelWs)).toEqual(
      expect.arrayContaining([
        { type: "client_connected", clientId, deviceToken: "grant", accountId: "user_owner" },
        expect.objectContaining({ type: "pair_request", accountId: "user_owner" }),
      ])
    );
  });
});
