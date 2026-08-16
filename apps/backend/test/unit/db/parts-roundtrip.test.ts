/**
 * `parts.data` holds the WIRE part, and the read path decodes it.
 *
 * Law 6 says forward what you cannot read. A ROW outlives the build that wrote
 * it, so it has to forward to the future too — which is what storing the
 * decoded `UnknownPart` wrapper (`{type, id, ..., raw: <payload>}`) destroys:
 * the wrapper is the writing build's ignorance, and a later build that LEARNS
 * the type would load it, fail its own `"raw" in part` checks and keep the
 * content hidden for a part it can now render perfectly.
 *
 * Real in-memory SQLite, and both halves of the trip: `persistPart` writes,
 * `attachParts` reads. Mocking either would only pin the shape each one
 * happens to produce today.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const SESSION = "sess-1";
const MESSAGE = "msg-1";

/** A type this build cannot read, and neither can the reader below. */
const UNKNOWN_TYPE = "chart";
/** A type this build cannot read, but the FUTURE reader below can. */
const FUTURE_TYPE = "tab-list";

// The "future build" reads with a decoder that knows FUTURE_TYPE. Only the READ
// path goes through this barrel — `persistPart` narrows with `isUnknownPart`
// from @zvada/agent-server/protocol/guards, a different module — so the write
// in these tests is genuinely performed by a build that does NOT know the type.
vi.mock("@zvada/agent-server/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zvada/agent-server/protocol")>();
  return {
    ...actual,
    decodePart: (value: unknown) => {
      const record = value as Record<string, unknown>;
      if (record?.type === FUTURE_TYPE) return { ...record } as never;
      return actual.decodePart(value);
    },
  };
});

// The WRITE side must decode the way the shipping build does — with the real
// decoder, which knows neither fake type — or the "written while ignorant" half
// of the round trip never happens.
const { decodePart } = await vi.importActual<typeof import("@zvada/agent-server/protocol")>(
  "@zvada/agent-server/protocol"
);

import { isUnknownPart } from "@shared/protocol-types";
import { persistPart } from "../../../src/services/agent/persistence";
import { attachParts } from "../../../src/db/queries";
import type { MessageRow } from "../../../src/db/types";

const { mockGetDatabase } = vi.hoisted(() => ({ mockGetDatabase: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));

/** The payload the engine put on the wire — no wrapper, no `raw`. */
function wirePart(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    id: `p-${type}`,
    sessionId: SESSION,
    messageId: MESSAGE,
    parentToolCallId: "tc-9",
    ...extra,
  };
}

const KNOWN_WIRE = {
  type: "text",
  id: "p-text",
  sessionId: SESSION,
  messageId: MESSAGE,
  text: "hello",
  state: "done",
};

describeWithDb("parts.data round trip", () => {
  let db: Database.Database;

  const rowFor = (id: string) =>
    db.prepare(`SELECT data FROM parts WHERE id = ?`).get(id) as { data: string };

  const readBack = () => attachParts(db, [{ id: MESSAGE } as MessageRow])[0].parts;

  /** Write, asserting the row actually landed — an empty read proves nothing. */
  const write = (wire: Record<string, unknown>, partIndex = 0) => {
    const decoded = decodePart(wire);
    expect(persistPart(SESSION, MESSAGE, decoded, partIndex).ok).toBe(true);
    return decoded;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO repositories (id, name, root_path) VALUES ('r1', 'repo', '/tmp/repo')`
    ).run();
    db.prepare(`INSERT INTO workspaces (id, repository_id, slug) VALUES ('w1', 'r1', 'ws')`).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, agent_harness) VALUES (?, 'w1', 'claude-code')`
    ).run(SESSION);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, sent_at) VALUES (?, ?, 'assistant', '2026-08-14T12:00:00.000Z')`
    ).run(MESSAGE, SESSION);
    mockGetDatabase.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("stores an unknown part as the WIRE payload, not the decoded wrapper", () => {
    const wire = wirePart(UNKNOWN_TYPE, { series: [1, 2, 3], title: "Latency" });
    const decoded = write(wire);
    // Precondition: this build really cannot read it, so the fold holds a wrapper.
    expect(isUnknownPart(decoded)).toBe(true);
    expect(decoded).toHaveProperty("raw");

    const stored = JSON.parse(rowFor(`p-${UNKNOWN_TYPE}`).data);
    expect(stored).toEqual(wire);
    // The wrapper is this build's reading of the payload — it must not be the row.
    expect(stored).not.toHaveProperty("raw");
  });

  it("reads an unknown part back as an UnknownPart with `raw` intact", () => {
    const wire = wirePart(UNKNOWN_TYPE, { series: [1, 2, 3], title: "Latency" });
    write(wire);

    const [part] = readBack();

    expect(isUnknownPart(part)).toBe(true);
    // Every consumer narrows on the `raw` KEY, not on the type list — the
    // decode is what keeps those two in agreement across the DB boundary.
    expect("raw" in part).toBe(true);
    expect(part).toMatchObject({
      type: UNKNOWN_TYPE,
      id: `p-${UNKNOWN_TYPE}`,
      sessionId: SESSION,
      messageId: MESSAGE,
      parentToolCallId: "tc-9",
      raw: wire,
    });
  });

  it("a FUTURE build that learns the type decodes the row it wrote while ignorant", () => {
    const wire = wirePart(FUTURE_TYPE, { tabs: ["a", "b"] });
    // Written by the build that could not read it: a wrapper went in.
    expect(isUnknownPart(write(wire))).toBe(true);

    // Read by the build that can: the content is visible, and there is no
    // wrapper left to hide it behind.
    const [part] = readBack();

    expect("raw" in part).toBe(false);
    expect(part).toMatchObject({ type: FUTURE_TYPE, id: `p-${FUTURE_TYPE}`, tabs: ["a", "b"] });
  });

  it("leaves a KNOWN part unchanged in both directions", () => {
    write(KNOWN_WIRE);

    expect(JSON.parse(rowFor("p-text").data)).toEqual(KNOWN_WIRE);
    expect(readBack()[0]).toEqual(KNOWN_WIRE);
  });

  it("keeps a row whose payload the decoder REJECTS — position is the array index", () => {
    // A malformed known part used to be passed straight through by the read
    // path; now it fails `PartSchema.parse`. Dropping it would silently shift
    // every part after it, so the fallback is the parsed value.
    db.prepare(
      `INSERT INTO parts (id, message_id, session_id, seq, type, data) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("p-bad", MESSAGE, SESSION, 0, "text", JSON.stringify({ type: "text", id: "p-bad" }));
    write(KNOWN_WIRE, 1);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const parts = readBack();

    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.id)).toEqual(["p-bad", "p-text"]);
  });
});
