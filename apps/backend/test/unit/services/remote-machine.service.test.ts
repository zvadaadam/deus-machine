import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  session: { deusCloudUrl: "https://cloud.test/", deusCloudSessionToken: null as string | null },
}));

vi.mock("../../../src/services/settings.service", () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  saveSetting: (key: string, value: unknown) => state.settings.set(key, value),
  removeSettings: (keys: string[]) =>
    keys.map((key) => state.settings.delete(key)).some((deleted) => deleted),
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getDeusCloudSessionConfig: () => state.session,
}));

import {
  CloudRequestError,
  currentAccountSession,
  forgetRemovedMachine,
  getMachineId,
  isMachineRemoved,
  MachineRemovedError,
  obtainHostTicket,
  retireLegacyRelayCredentials,
} from "../../../src/services/remote-machine.service";

const sessionFor = (sub: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;

type Call = { url: string; body: Record<string, unknown>; authorization: string | null };
let calls: Call[];
let answers: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  state.settings.clear();
  state.session.deusCloudSessionToken = sessionFor("user_a");
  calls = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        authorization: new Headers(init.headers).get("authorization"),
      });
      const answer = answers.shift() ?? { status: 500, body: { message: "unexpected call" } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    })
  );
});

const signal = () => new AbortController().signal;

describe("account session", () => {
  it("reads the desktop session's account and trims the Cloud URL", () => {
    expect(currentAccountSession()).toEqual({
      cloudUrl: "https://cloud.test",
      sessionToken: sessionFor("user_a"),
      accountId: "user_a",
    });
    state.session.deusCloudSessionToken = "not-a-jwt";
    expect(currentAccountSession()).toBeNull();
    state.session.deusCloudSessionToken = null;
    expect(currentAccountSession()).toBeNull();
  });
});

describe("host tickets", () => {
  it("registers once per account, then reuses the machine and its secret", async () => {
    const session = currentAccountSession()!;
    answers.push(
      { status: 201, body: { machine: { id: "0123456789abcdef" } } },
      { status: 200, body: { ticket: "t1" } },
      { status: 200, body: { ticket: "t2" } }
    );
    expect(await obtainHostTicket(session, "Studio", signal())).toEqual({
      machineId: "0123456789abcdef",
      ticket: "t1",
    });
    expect(await obtainHostTicket(session, "Studio", signal())).toMatchObject({ ticket: "t2" });

    const [register, first, second] = calls;
    expect(register.url).toBe("https://cloud.test/me/machines");
    expect(register.authorization).toBe(`Bearer ${sessionFor("user_a")}`);
    expect(register.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.url).toBe("https://cloud.test/me/machines/0123456789abcdef/tickets");
    expect(first.body).toEqual({ role: "host", secret: register.body.secret, name: "Studio" });
    expect(second.body.secret).toBe(register.body.secret);
    expect(getMachineId("user_a")).toBe("0123456789abcdef");
    expect(getMachineId("user_b")).toBeNull();
  });

  it("treats a removed machine as removed until remote access is turned on again", async () => {
    const session = currentAccountSession()!;
    state.settings.set("relay_machines", {
      user_a: { machineId: "aaaaaaaaaaaaaaaa", secret: "s".repeat(43) },
    });
    answers.push({ status: 404, body: { error: "NOT_FOUND", message: "Computer not found." } });
    await expect(obtainHostTicket(session, "Studio", signal())).rejects.toBeInstanceOf(
      MachineRemovedError
    );
    // Durable across restarts, and no quiet re-registration.
    expect(isMachineRemoved("user_a")).toBe(true);
    expect(getMachineId("user_a")).toBeNull();
    await expect(obtainHostTicket(session, "Studio", signal())).rejects.toBeInstanceOf(
      MachineRemovedError
    );
    expect(calls).toHaveLength(1);

    forgetRemovedMachine("user_a");
    answers.push(
      { status: 201, body: { machine: { id: "bbbbbbbbbbbbbbbb" } } },
      { status: 200, body: { ticket: "fresh" } }
    );
    expect(await obtainHostTicket(session, "Studio", signal())).toEqual({
      machineId: "bbbbbbbbbbbbbbbb",
      ticket: "fresh",
    });
  });

  it("registers again, once, when the stored secret no longer matches", async () => {
    const session = currentAccountSession()!;
    state.settings.set("relay_machines", {
      user_a: { machineId: "aaaaaaaaaaaaaaaa", secret: "s".repeat(43) },
    });
    answers.push(
      {
        status: 403,
        body: { error: "MACHINE_SECRET_MISMATCH", message: "This computer must register again." },
      },
      { status: 201, body: { machine: { id: "cccccccccccccccc" } } },
      { status: 200, body: { ticket: "fresh" } }
    );
    expect(await obtainHostTicket(session, "Studio", signal())).toEqual({
      machineId: "cccccccccccccccc",
      ticket: "fresh",
    });

    answers.push(
      {
        status: 403,
        body: { error: "MACHINE_SECRET_MISMATCH", message: "This computer must register again." },
      },
      { status: 201, body: { machine: { id: "dddddddddddddddd" } } },
      {
        status: 403,
        body: { error: "MACHINE_SECRET_MISMATCH", message: "This computer must register again." },
      }
    );
    await expect(obtainHostTicket(session, "Studio", signal())).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toHaveLength(6);
  });

  it("keeps the machine through outages and expired sessions", async () => {
    const session = currentAccountSession()!;
    state.settings.set("relay_machines", {
      user_a: { machineId: "aaaaaaaaaaaaaaaa", secret: "s".repeat(43) },
    });
    answers.push({
      status: 401,
      body: { error: "UNAUTHORIZED", message: "Invalid session token" },
    });
    const error = await obtainHostTicket(session, "Studio", signal()).catch((e) => e);
    expect(error).toBeInstanceOf(CloudRequestError);
    expect(error.message).toBe("Invalid session token");
    expect(getMachineId("user_a")).toBe("aaaaaaaaaaaaaaaa");
  });

  it("keeps machine names within Deus Cloud's limit", async () => {
    answers.push(
      { status: 201, body: { machine: { id: "0123456789abcdef" } } },
      { status: 200, body: { ticket: "t" } }
    );
    await obtainHostTicket(currentAccountSession()!, `  ${"M".repeat(120)}  `, signal());
    expect(calls[0].body.name).toBe("M".repeat(80));
  });
});

describe("pre-account relay credentials", () => {
  it("are removed from disk; this computer's machine records stay", () => {
    state.settings.set("relay_server_id", "abcd1234");
    state.settings.set("relay_token", "t".repeat(64));
    state.settings.set("relay_machines", { user_a: { machineId: "m", secret: "s" } });
    retireLegacyRelayCredentials();
    expect(state.settings.has("relay_server_id")).toBe(false);
    expect(state.settings.has("relay_token")).toBe(false);
    expect(state.settings.get("relay_machines")).toEqual({
      user_a: { machineId: "m", secret: "s" },
    });
  });
});
