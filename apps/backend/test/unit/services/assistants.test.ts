// Hosted assistants: admission by the account's own access token, verified on
// this computer, and what the person allows each one to do.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { SCHEMA_SQL } from "@shared/schema";
import type { AssistantDecision } from "@shared/types/assistants";

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: { cloudUrl: "https://cloud.test", sessionToken: "session-a", accountId: "user_a" } as {
    cloudUrl: string;
    sessionToken: string;
    accountId: string;
  } | null,
  machineId: "0123456789abcdef" as string | null,
  remoteAccess: true,
  invalidate: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => state.db }));
vi.mock("../../../src/services/account-session", () => ({
  currentAccountSession: () => state.session,
}));
vi.mock("../../../src/services/remote-machine.service", () => ({
  getMachineId: () => state.machineId,
}));
vi.mock("../../../src/services/settings.service", () => ({
  getSetting: (key: string) => (key === "remote_access_enabled" ? state.remoteAccess : null),
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: state.invalidate }));

import {
  _resetLabels,
  admitAssistant,
  AssistantRefusedError,
  forgetUnusedAssistants,
  listAssistants,
  removeAssistant,
  setAssistantAccess,
} from "../../../src/services/assistants";
import { fallbackName } from "../../../src/services/assistants/label";
import { isAssistantToken, useAssistantKeys } from "../../../src/services/assistants/token";
import { ASSISTANT_ISSUER } from "../../../src/lib/network";
import { addConnection, closeAll, getConnection } from "../../../src/services/ws.service";
import { ASSISTANT_HOST } from "../../helpers";

const MACHINE = "0123456789abcdef";
const AUDIENCE = `https://cloud.test/mcp/${MACHINE}`;
const HOST = { accountId: "user_a", machineId: MACHINE, cloudUrl: "https://cloud.test" };
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let issuerKeys: Keys;
let strangerKeys: Keys;
let fetchMock: ReturnType<typeof vi.fn>;

interface Claims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  client_id?: string | null;
  expiresIn?: string | number;
  /** Signed with a key the issuer never published. */
  stranger?: boolean;
  extra?: Record<string, unknown>;
}

async function token({
  iss = ASSISTANT_ISSUER,
  aud = AUDIENCE,
  sub = "user_a",
  client_id = CLAUDE,
  expiresIn = "1h",
  stranger = false,
  extra = {},
}: Claims = {}): Promise<string> {
  return new SignJWT({ ...(client_id === null ? {} : { client_id }), ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "issuer" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign((stranger ? strangerKeys : issuerKeys).privateKey);
}

beforeEach(async () => {
  issuerKeys ??= await generateKeyPair("RS256");
  strangerKeys ??= await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(issuerKeys.publicKey)), kid: "issuer", alg: "RS256" };
  useAssistantKeys(createLocalJWKSet({ keys: [jwk] }));

  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  state.db = db;
  state.session = {
    cloudUrl: "https://cloud.test",
    sessionToken: "session-a",
    accountId: "user_a",
  };
  state.machineId = MACHINE;
  state.remoteAccess = true;
  state.invalidate.mockClear();
  _resetLabels();
  // Deus Cloud's name for the assistant; tests that need a failure override it.
  fetchMock = vi.fn(async () => Response.json({ name: "Claude", host: "claude.ai" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.useRealTimers();
  // Let a name lookup still under way finish before its database goes.
  await new Promise((resolve) => setImmediate(resolve));
  closeAll();
  useAssistantKeys(null);
  (state.db as Database.Database).close();
  vi.unstubAllGlobals();
});

describe("telling an assistant from a device", () => {
  it("reads a three-part token as an access token, anything else as a device grant", () => {
    expect(isAssistantToken("a.b.c")).toBe(true);
    expect(isAssistantToken("deus_device_grant")).toBe(false);
  });
});

describe("admission", () => {
  it("admits a token signed by the issuer for this computer and account, as pending", async () => {
    // Recorded at admission, before its first message: one that only ever
    // sends `initialize` is listed as waiting all the same.
    await expect(admitAssistant(await token(), HOST)).resolves.toEqual({
      // Its approval is the account's and machine's it was verified for.
      assistant: {
        clientId: CLAUDE,
        access: "pending",
        host: { accountId: "user_a", machineId: "0123456789abcdef" },
      },
      signInEndsAt: expect.any(Number),
    });
    expect(listAssistants()).toEqual([
      expect.objectContaining({ clientId: CLAUDE, access: "pending" }),
    ]);
    // A first contact reaches an open window at once, so the person can decide.
    expect(state.invalidate).toHaveBeenCalledWith(["assistants"]);
  });

  it.each<[string, Claims, string]>([
    ["another issuer", { iss: "https://elsewhere.test" }, "not issued by Deus"],
    [
      "another computer's address",
      { aud: "https://cloud.test/mcp/ffffffffffffffff" },
      "another computer",
    ],
    ["another account", { sub: "user_b" }, "different Deus account"],
    ["an expired sign-in", { expiresIn: Math.floor(Date.now() / 1000) - 3600 }, "expired"],
    ["a key that is not the issuer's", { stranger: true }, "could not be verified"],
    ["no assistant named", { client_id: null }, "which assistant"],
    // Deus Cloud's own check: one audience only, and a person's sign-in.
    [
      "a sign-in for this computer and another",
      { aud: [AUDIENCE, "https://cloud.test/mcp/ffffffffffffffff"] },
      "not for this computer alone",
    ],
    ["an AI agent's own sign-in", { extra: { sub_profile: "ai_agent" } }, "AI agent's own"],
  ])("refuses %s, saying why", async (_case, claims, reason) => {
    const refusal = admitAssistant(await token(claims), HOST);
    await expect(refusal).rejects.toBeInstanceOf(AssistantRefusedError);
    await expect(refusal).rejects.toThrow(reason);
    expect(listAssistants()).toEqual([]);
  });

  it("accepts a one-entry audience list, as Deus Cloud does", async () => {
    await expect(admitAssistant(await token({ aud: [AUDIENCE] }), HOST)).resolves.toMatchObject({
      assistant: { clientId: CLAUDE },
    });
  });

  it("says when the sign-in ends, with the clock tolerance, so its connection ends then", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const { signInEndsAt } = await admitAssistant(await token({ expiresIn: exp }), HOST);
    expect(signInEndsAt).toBe((exp + 30) * 1000);
  });

  it("refuses a token whose signature was altered", async () => {
    const [header, payload, signature] = (await token()).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
        client_id: "someone-else",
      })
    ).toString("base64url");
    await expect(admitAssistant(`${header}.${forged}.${signature}`, HOST)).rejects.toThrow(
      "could not be verified"
    );
  });

  it("accepts only public-key signatures: ES256 as well as RS256, never a shared secret", async () => {
    const claims = (alg: string) =>
      new SignJWT({ client_id: CLAUDE })
        .setProtectedHeader({ alg })
        .setIssuer(ASSISTANT_ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("user_a")
        .setExpirationTime("1h");

    const elliptic = await generateKeyPair("ES256");
    useAssistantKeys(async () => elliptic.publicKey);
    await expect(
      admitAssistant(await claims("ES256").sign(elliptic.privateKey), HOST)
    ).resolves.toMatchObject({ assistant: { clientId: CLAUDE } });

    // A key set that hands out a secret must still not admit a token signed with it.
    const secret = new TextEncoder().encode("a secret anyone with the key set could sign with");
    useAssistantKeys(async () => secret);
    await expect(admitAssistant(await claims("HS256").sign(secret), HOST)).rejects.toThrow(
      "could not be verified"
    );
  });

  it("says it could not check, not that the sign-in is bad, when the keys cannot be read", async () => {
    useAssistantKeys(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(admitAssistant(await token(), HOST)).rejects.toThrow("could not check");
  });

  // jose throws a plain JOSEError for these, the class a bad token's errors share.
  it.each([
    ["answers other than 200", () => new Response("unavailable", { status: 503 })],
    ["answers with something that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("says it could not check when the key set's URL %s", async (_case, answer) => {
    useAssistantKeys(
      createRemoteJWKSet(new URL("https://issuer.test/oauth2/jwks"), {
        [customFetch]: async () => answer(),
      })
    );
    await expect(admitAssistant(await token(), HOST)).rejects.toThrow(
      "This computer could not check the sign-in right now. Try again."
    );
  });
});

describe("the assistant's name and host", () => {
  it("is Deus Cloud's name and host for it, asked once with the desktop's session", async () => {
    fetchMock.mockImplementation(async () => Response.json({ name: "Claude", host: "Claude.ai" }));
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    expect(listAssistants()[0]).toMatchObject({ name: "client_01ABC", host: null });
    await vi.waitFor(() =>
      expect(listAssistants()[0]).toMatchObject({ name: "Claude", host: "claude.ai" })
    );
    // The person sees the name it learned.
    expect(state.invalidate).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://cloud.test/me/assistants/client_01ABC`,
      expect.objectContaining({ headers: { authorization: "Bearer session-a" } })
    );
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes a URL-shaped client id's host as its host from the first contact", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 502 }));
    await admitAssistant(await token(), HOST);
    expect(listAssistants()[0]).toMatchObject({ name: "claude.ai", host: "claude.ai" });
  });

  it("asks again on a later contact when Deus Cloud could not say, at most every few minutes", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    fetchMock.mockImplementation(async () => new Response("nope", { status: 502 }));
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.setSystemTime(Date.now() + 60_000);
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => Response.json({ name: "Grok", host: "grok.com" }));
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    await vi.waitFor(() =>
      expect(listAssistants()[0]).toMatchObject({ name: "Grok", host: "grok.com" })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks again on a later contact when the name it learned could not be saved", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => Response.json({ name: "Grok", host: "grok.com" }));
    const db = state.db as Database.Database;
    db.exec(`CREATE TRIGGER no_names BEFORE UPDATE OF name ON assistants
             BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    db.exec("DROP TRIGGER no_names");

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    await vi.waitFor(() =>
      expect(listAssistants()[0]).toMatchObject({ name: "Grok", host: "grok.com" })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to something readable when Deus Cloud cannot say, without holding up admission", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 502 }));
    await expect(admitAssistant(await token(), HOST)).resolves.toMatchObject({
      assistant: { clientId: CLAUDE },
    });
    expect(listAssistants()[0]?.name).toBe("claude.ai");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(listAssistants()[0]?.name).toBe("claude.ai");
  });

  it("says nothing it cannot use: a host that is not one is dropped", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ name: "Claude", host: "claude.ai\n-> archive_workspace()" })
    );
    await admitAssistant(await token({ client_id: "client_01ABC" }), HOST);
    await vi.waitFor(() => expect(listAssistants()[0]?.name).toBe("Claude"));
    expect(listAssistants()[0]?.host).toBeNull();
  });

  it("uses the host of a URL-shaped client id, else the id itself", () => {
    expect(fallbackName(CLAUDE)).toBe("claude.ai");
    expect(fallbackName("client_01ABC")).toBe("client_01ABC");
  });
});

describe("what a person sees change", () => {
  it("is pushed for a first contact, not for every call; last seen is written once a minute", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await admitAssistant(await token(), HOST);
    await vi.waitFor(() => expect(listAssistants()[0]?.name).toBe("Claude"));
    const firstSeen = listAssistants()[0]!.lastSeenAt;
    state.invalidate.mockClear();

    vi.setSystemTime(Date.now() + 30_000);
    await admitAssistant(await token(), HOST);
    expect(state.invalidate).not.toHaveBeenCalled();
    expect(listAssistants()[0]!.lastSeenAt).toBe(firstSeen);

    vi.setSystemTime(Date.now() + 31_000);
    await admitAssistant(await token(), HOST);
    expect(listAssistants()[0]!.lastSeenAt).toBe(Date.now());
    expect(state.invalidate).not.toHaveBeenCalled();

    setAssistantAccess(CLAUDE, "read");
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith(["assistants"]);
  });
});

describe("what the person allows", () => {
  it("goes pending, read, operate, removed; each change closes the assistant's connections", async () => {
    const connect = async () => {
      const admission = await admitAssistant(await token(), HOST);
      const close = vi.fn();
      const id = addConnection({ send: vi.fn(), close }, null, true, admission);
      return { id, access: admission.assistant.access, close };
    };

    const first = await connect();
    expect(first.access).toBe("pending");

    expect(setAssistantAccess(CLAUDE, "read")).toBe(true);
    expect(getConnection(first.id)).toBeUndefined();
    expect(first.close).toHaveBeenCalledWith(4001, "Assistant access changed");

    const second = await connect();
    expect(second.access).toBe("read");
    expect(setAssistantAccess(CLAUDE, "operate")).toBe(true);
    expect(getConnection(second.id)).toBeUndefined();

    const third = await connect();
    expect(third.access).toBe("operate");
    expect(removeAssistant(CLAUDE)).toBe(true);
    expect(getConnection(third.id)).toBeUndefined();
    expect(listAssistants()).toEqual([]);

    // Removed is forgotten: the next contact is a first contact again.
    expect((await connect()).access).toBe("pending");
  });

  it("keeps a denied assistant listed and refuses its next contact, until it is removed", async () => {
    await admitAssistant(await token(), HOST);
    await vi.waitFor(() => expect(listAssistants()[0]?.name).toBe("Claude"));
    const close = vi.fn();
    const id = addConnection({ send: vi.fn(), close }, null, true, {
      assistant: { clientId: CLAUDE, access: "operate", host: ASSISTANT_HOST },
      signInEndsAt: Infinity,
    });
    const seen = listAssistants()[0]!.lastSeenAt;
    state.invalidate.mockClear();

    expect(setAssistantAccess(CLAUDE, "denied")).toBe(true);
    expect(getConnection(id)).toBeUndefined();
    expect(close).toHaveBeenCalledWith(4001, "Assistant access changed");

    const refused = admitAssistant(await token(), HOST);
    await expect(refused).rejects.toBeInstanceOf(AssistantRefusedError);
    await expect(refused).rejects.toThrow("This assistant was denied on this computer.");
    expect(listAssistants()).toEqual([
      expect.objectContaining({ clientId: CLAUDE, access: "denied", lastSeenAt: seen }),
    ]);
    // Only the deny itself was shown, not the refused contact.
    expect(state.invalidate).toHaveBeenCalledTimes(1);

    expect(removeAssistant(CLAUDE)).toBe(true);
    await expect(admitAssistant(await token(), HOST)).resolves.toMatchObject({
      assistant: { access: "pending" },
    });
  });

  it("does not touch other assistants' or devices' connections", async () => {
    await admitAssistant(await token(), HOST);
    const other = addConnection({ send: vi.fn(), close: vi.fn() }, null, true, {
      assistant: { clientId: "other", access: "operate", host: ASSISTANT_HOST },
      signInEndsAt: Infinity,
    });
    const phone = addConnection({ send: vi.fn(), close: vi.fn() }, "phone", true);
    setAssistantAccess(CLAUDE, "operate");
    expect(getConnection(other)).toBeDefined();
    expect(getConnection(phone)).toBeDefined();
  });

  it("keeps each account's decisions apart", async () => {
    await admitAssistant(await token(), HOST);
    setAssistantAccess(CLAUDE, "operate");
    state.session = {
      cloudUrl: "https://cloud.test",
      sessionToken: "session-b",
      accountId: "user_b",
    };
    expect(listAssistants()).toEqual([]);
    expect(setAssistantAccess(CLAUDE, "read")).toBe(false);
    const asB = await admitAssistant(await token({ sub: "user_b" }), {
      ...HOST,
      accountId: "user_b",
    });
    expect(asB.assistant.access).toBe("pending");
  });

  it("answers false for an assistant it does not know", () => {
    expect(setAssistantAccess("nobody", "read")).toBe(false);
    expect(removeAssistant("nobody")).toBe(false);
  });
});

describe("approvals that are not used", () => {
  const DAY = 24 * 60 * 60_000;
  const CODEX = "codex-cli-registered-at-sign-in";

  async function admitted(clientId: string, access: AssistantDecision) {
    await admitAssistant(await token({ client_id: clientId }), HOST);
    setAssistantAccess(clientId, access);
  }

  it("lapse after 30 days unseen: the list forgets them, a denied one stays", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await admitted(CLAUDE, "operate");
    await admitted(CODEX, "read");
    await admitted("blocked", "denied");
    vi.setSystemTime(Date.now() + 29 * DAY);
    // Claude is used again; the others are not.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await admitAssistant(await token(), HOST);
    expect(listAssistants()).toHaveLength(3);

    vi.setSystemTime(Date.now() + 2 * DAY);
    state.invalidate.mockClear();
    const kept = listAssistants().map((a) => `${a.clientId} ${a.access}`);
    expect(kept.sort()).toEqual(["blocked denied", `${CLAUDE} operate`].sort());
    // A pure read: it leaves the lapsed one out, and deletes nothing or tells anyone.
    const rows = (state.db as Database.Database).prepare("SELECT client_id FROM assistants").all();
    expect(rows).toHaveLength(3);
    expect(state.invalidate).not.toHaveBeenCalled();
  });

  it("make a forgotten assistant a first contact again, waiting for the person", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await admitted(CODEX, "operate");
    vi.setSystemTime(Date.now() + 31 * DAY);
    state.invalidate.mockClear();
    const again = await admitAssistant(await token({ client_id: CODEX }), HOST);
    expect(again.assistant.access).toBe("pending");
    expect(state.invalidate).toHaveBeenCalledWith(["assistants"]);
  });

  it("are forgotten at startup for every account, signed in or not", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await admitted(CODEX, "operate");
    vi.setSystemTime(Date.now() + 31 * DAY);
    state.session = null;
    state.invalidate.mockClear();
    forgetUnusedAssistants();
    const rows = (state.db as Database.Database).prepare("SELECT client_id FROM assistants").all();
    expect(rows).toEqual([]);
    // An open list is told; one with nothing to forget is not.
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith(["assistants"]);
    forgetUnusedAssistants();
    expect(state.invalidate).toHaveBeenCalledTimes(1);
  });

  it("are forgotten at admission, and an open list is told", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await admitted(CODEX, "operate");
    await admitted(CLAUDE, "operate");
    vi.setSystemTime(Date.now() + 31 * DAY);
    state.invalidate.mockClear();
    // Both lapsed: forgotten as Codex is admitted, which comes back as a first contact.
    await admitAssistant(await token({ client_id: CODEX }), HOST);
    const rows = (state.db as Database.Database)
      .prepare("SELECT client_id FROM assistants")
      .all() as { client_id: string }[];
    expect(rows.map((r) => r.client_id)).toEqual([CODEX]);
    expect(state.invalidate).toHaveBeenCalledWith(["assistants"]);
  });
});
