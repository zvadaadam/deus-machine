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
  hasListeners,
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
    expect(hasListeners(notice, {})).toBe(false);
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
    expect(first.map((f) => (f as { seq: number }).seq)).toEqual([1, 2, 3]);

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

  it("delivers an event nobody keeps without numbering it, and never replays it", () => {
    const live = connect("live");
    subscribe("live", "s1", events, { sessionId: "a" });
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 99 }, { keep: false });
    publish(events, { sessionId: "a" }, { n: 2 });
    expect(
      live.map((f) => [(f as { data: { n: number } }).data.n, (f as { seq: number }).seq])
    ).toEqual([
      [1, 1],
      [99, 1],
      [2, 2],
    ]);

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 0);
    expect(back.map((f) => (f as { data: { n: number } }).data.n)).toEqual([1, 2]);
  });

  it("uses the source's own numbers when it has them", () => {
    connect("a");
    publish(events, { sessionId: "a" }, { n: 1 }, { seq: 41 });
    publish(events, { sessionId: "a" }, { n: 2 }, { seq: 42 });
    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 41);
    expect(back).toEqual([
      { type: "q:event", id: "s1", event: "sessionEvents", data: { n: 2 }, seq: 42 },
    ]);
  });

  it("tells a subscriber to read again when it cannot say what was missed", () => {
    for (let n = 1; n <= 600; n++) publish(events, { sessionId: "a" }, { n });

    // Fell out of what is remembered.
    const old = connect("old");
    subscribe("old", "s1", events, { sessionId: "a" }, 10);
    expect(old).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // Saw numbers this log never issued: the source started over.
    const ahead = connect("ahead");
    subscribe("ahead", "s1", events, { sessionId: "a" }, 900);
    expect(ahead).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // Nothing has been published under this scope since the process started.
    const unknown = connect("unknown");
    subscribe("unknown", "s1", events, { sessionId: "never" }, 5);
    expect(unknown).toEqual([{ type: "q:reset", id: "s1", seq: 0 }]);
    const fresh = connect("fresh");
    subscribe("fresh", "s1", events, { sessionId: "never" }, 0);
    expect(fresh).toEqual([]);
  });

  it("starts over at a snapshot and when the source starts numbering again", () => {
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    publish(events, { sessionId: "a" }, { n: 3 }, { restart: true });
    publish(events, { sessionId: "a" }, { n: 4 });
    // The snapshot restates what came before it: a resume from before it starts there.
    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 1);
    expect(back.map((f) => (f as { seq: number }).seq)).toEqual([3, 4]);

    publish(events, { sessionId: "b" }, { n: 1 }, { seq: 7 });
    publish(events, { sessionId: "b" }, { n: 2 }, { seq: 1 });
    const other = connect("other");
    subscribe("other", "s1", events, { sessionId: "b" }, 7);
    expect(other).toEqual([{ type: "q:reset", id: "s1", seq: 1 }]);
  });

  it("only resumes a subscription that names its whole scope", () => {
    connect("phone");
    expect(() => subscribe("phone", "s1", events, {}, 3)).toThrow("whole scope");
  });
});
