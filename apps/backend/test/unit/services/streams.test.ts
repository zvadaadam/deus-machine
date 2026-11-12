import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { out } from "@shared/api/op";
import { resumableStream, stream } from "@shared/api/stream";

const sent = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: (id: string) =>
    sent.has(id)
      ? { ws: { send: (frame: string) => sent.get(id)!.push(JSON.parse(frame)) } }
      : undefined,
}));

import {
  _reset,
  dropConnection,
  publish,
  subscribe,
  unsubscribe,
} from "../../../src/services/streams";

const output = stream({
  name: "terminalOutput",
  scope: z.object({ workspaceId: z.string(), id: z.string() }),
  event: out<{ text: string }>(),
});
const events = resumableStream({
  name: "sessionEvents",
  scope: z.object({ sessionId: z.string() }),
  event: out<{ n: number }>(),
});
const notice = stream({ name: "notice", event: out<string>() });

type Numbered = { seq?: number };
const seqs = (frames: unknown[]) => frames.map((frame) => (frame as Numbered).seq);

function connect(id: string): unknown[] {
  sent.set(id, []);
  return sent.get(id)!;
}

beforeEach(() => {
  _reset();
  sent.clear();
});

describe("streams", () => {
  it("sends an event only to the subscriptions it matches", () => {
    const phone = connect("phone");
    const laptop = connect("laptop");
    const idle = connect("idle");
    subscribe("phone", "s1", output, { id: "t1" });
    subscribe("laptop", "s1", output, { workspaceId: "w1" });
    subscribe("laptop", "s2", output, {});

    publish(output, { workspaceId: "w1", id: "t1" }, { text: "a" });
    publish(output, { workspaceId: "w2", id: "t2" }, { text: "b" });

    expect(phone).toEqual([
      { type: "q:event", id: "s1", event: "terminalOutput", data: { text: "a" } },
    ]);
    expect(
      laptop.map((f) => [(f as { id: string }).id, (f as { data: { text: string } }).data.text])
    ).toEqual([
      ["s1", "a"],
      ["s2", "a"],
      ["s2", "b"],
    ]);
    // A connection that asked for nothing receives nothing.
    expect(idle).toEqual([]);
  });

  it("stops after unsubscribe, and when the connection goes", () => {
    const phone = connect("phone");
    subscribe("phone", "s1", notice, {});
    subscribe("phone", "s2", notice, {});
    publish(notice, {}, "one");
    expect(unsubscribe("phone", "s1")).toBe(true);
    publish(notice, {}, "two");
    dropConnection("phone");
    publish(notice, {}, "three");
    expect(phone.map((f) => `${(f as { id: string }).id}:${(f as { data: string }).data}`)).toEqual(
      ["s1:one", "s2:one", "s2:two"]
    );
  });

  it("refuses a scope the stream does not have", () => {
    connect("phone");
    expect(() => subscribe("phone", "s1", output, { id: 7 })).toThrow("terminalOutput");
  });

  it("numbers kept events per scope and replays what a returning subscriber missed", () => {
    const first = connect("first");
    subscribe("first", "s1", events, { sessionId: "a" });
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    publish(events, { sessionId: "b" }, { n: 10 });
    publish(events, { sessionId: "a" }, { n: 3 });
    expect(seqs(first)).toEqual([1, 2, 3]);

    const back = connect("back");
    subscribe("back", "s9", events, { sessionId: "a" }, 1);
    expect(back).toEqual([
      { type: "q:event", id: "s9", event: "sessionEvents", data: { n: 2 }, seq: 2 },
      { type: "q:event", id: "s9", event: "sessionEvents", data: { n: 3 }, seq: 3 },
    ]);

    const current = connect("current");
    subscribe("current", "s1", events, { sessionId: "a" }, 3);
    expect(current).toEqual([]);
  });

  it("delivers an event nobody keeps under the last kept number, and never replays it", () => {
    const live = connect("live");
    subscribe("live", "s1", events, { sessionId: "a" });
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 99 }, { keep: false });
    publish(events, { sessionId: "a" }, { n: 2 });
    expect(live.map((f) => [(f as { data: { n: number } }).data.n, (f as Numbered).seq])).toEqual([
      [1, 1],
      [99, 1],
      [2, 2],
    ]);

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 1);
    expect(back.map((f) => (f as { data: { n: number } }).data.n)).toEqual([2]);
  });

  it("tells a subscriber to read again when it cannot say what was missed", () => {
    for (let n = 1; n <= 600; n++) publish(events, { sessionId: "a" }, { n });

    // Fell out of what is remembered.
    const old = connect("old");
    subscribe("old", "s1", events, { sessionId: "a" }, 10);
    expect(old).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // A number this log never issued.
    const ahead = connect("ahead");
    subscribe("ahead", "s1", events, { sessionId: "a" }, 900);
    expect(ahead).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // Nothing has been published under this scope since the process started.
    const unknown = connect("unknown");
    subscribe("unknown", "s1", events, { sessionId: "never" }, 5);
    expect(unknown).toEqual([{ type: "q:reset", id: "s1" }]);
  });

  it("never replays one process's events to a subscriber of an earlier one", () => {
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    // The process restarts and keeps more than the subscriber had seen before it.
    _reset(1000);
    for (let n = 1; n <= 5; n++) publish(events, { sessionId: "a" }, { n });

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 2);
    expect(back).toEqual([{ type: "q:reset", id: "s1", seq: 1005 }]);
    // From there it follows the new log.
    publish(events, { sessionId: "a" }, { n: 6 });
    expect(seqs(back)).toEqual([1005, 1006]);
  });

  it("starts a replay at a snapshot, whatever the subscriber saw before it", () => {
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    publish(events, { sessionId: "a" }, { n: 3 }, { restart: true });
    publish(events, { sessionId: "a" }, { n: 4 });
    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 1);
    expect(seqs(back)).toEqual([3, 4]);
  });

  it("numbers events only for a subscription that names its whole scope", () => {
    const all = connect("all");
    subscribe("all", "s1", events, {});
    publish(events, { sessionId: "a" }, { n: 1 });
    expect(all).toEqual([{ type: "q:event", id: "s1", event: "sessionEvents", data: { n: 1 } }]);

    // It has no place to resume from, so a return is a reset.
    const back = connect("back");
    subscribe("back", "s1", events, {}, 1);
    expect(back).toEqual([{ type: "q:reset", id: "s1" }]);
  });

  it("forgets the scope published least recently when it holds too many", () => {
    for (let n = 0; n < 65; n++) publish(events, { sessionId: `s${n}` }, { n });
    const first = connect("first");
    subscribe("first", "s1", events, { sessionId: "s0" }, 0);
    expect(first).toEqual([{ type: "q:reset", id: "s1" }]);
    const last = connect("last");
    subscribe("last", "s1", events, { sessionId: "s64" }, 0);
    expect(seqs(last)).toEqual([1]);
  });
});
