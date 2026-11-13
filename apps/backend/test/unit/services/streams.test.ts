import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { out } from "@shared/api/op";
import { resumableStream, stream } from "@shared/api/stream";

const sent = vi.hoisted(() => new Map<string, Frame[]>());
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: (id: string) =>
    sent.has(id)
      ? { ws: { send: (frame: string) => sent.get(id)!.push(JSON.parse(frame)) } }
      : undefined,
}));

import {
  _reset,
  dropConnection,
  openWith,
  publish,
  resetSubscribers,
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

interface Frame {
  type: string;
  id: string;
  seq?: number;
  data?: unknown;
}

function connect(id: string): Frame[] {
  sent.set(id, []);
  return sent.get(id)!;
}
/** The events a connection was sent, without the acknowledgment of each subscription. */
const heard = (frames: Frame[]) => frames.filter((frame) => frame.type !== "q:subscribed");
const seqs = (frames: Frame[]) => heard(frames).map((frame) => frame.seq);
const numbers = (frames: Frame[]) => heard(frames).map((frame) => (frame.data as { n: number }).n);

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

    expect(heard(phone)).toEqual([
      { type: "q:event", id: "s1", event: "terminalOutput", data: { text: "a" } },
    ]);
    expect(heard(laptop).map((f) => [f.id, (f.data as { text: string }).text])).toEqual([
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
    expect(heard(phone).map((f) => `${f.id}:${f.data}`)).toEqual(["s1:one", "s2:one", "s2:two"]);
  });

  it("refuses a scope the stream does not have", () => {
    connect("phone");
    expect(() => subscribe("phone", "s1", output, { id: 7 })).toThrow("terminalOutput");
  });

  it("acknowledges a subscription, saying where a numbered scope stands", () => {
    const phone = connect("phone");
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    subscribe("phone", "busy", events, { sessionId: "a" });
    subscribe("phone", "quiet", events, { sessionId: "never" });
    subscribe("phone", "plain", notice, {});
    expect(phone).toEqual([
      { type: "q:subscribed", id: "busy", seq: 2 },
      // Nothing published here yet: it stands where this process began numbering.
      { type: "q:subscribed", id: "quiet", seq: 0 },
      { type: "q:subscribed", id: "plain" },
    ]);
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
      { type: "q:subscribed", id: "s9", seq: 3 },
    ]);

    const current = connect("current");
    subscribe("current", "s1", events, { sessionId: "a" }, 3);
    expect(heard(current)).toEqual([]);
  });

  it("sends nothing to a subscriber that returns to a scope where nothing happened", () => {
    // It was told where the scope stood when it first subscribed, and names that.
    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "quiet" }, 0);
    expect(heard(back)).toEqual([]);

    // What happens there afterwards is replayed to one that was away for it.
    publish(events, { sessionId: "quiet" }, { n: 1 });
    const later = connect("later");
    subscribe("later", "s1", events, { sessionId: "quiet" }, 0);
    expect(numbers(later)).toEqual([1]);
  });

  it("delivers an event nobody keeps under the last kept number, and never replays it", () => {
    const live = connect("live");
    subscribe("live", "s1", events, { sessionId: "a" });
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 99 }, { keep: false });
    publish(events, { sessionId: "a" }, { n: 2 });
    expect(heard(live).map((f) => [(f.data as { n: number }).n, f.seq])).toEqual([
      [1, 1],
      [99, 1],
      [2, 2],
    ]);

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 1);
    expect(numbers(back)).toEqual([2]);
  });

  it("tells a subscriber to read again when it cannot say what was missed", () => {
    for (let n = 1; n <= 600; n++) publish(events, { sessionId: "a" }, { n });

    // Fell out of what is remembered.
    const old = connect("old");
    subscribe("old", "s1", events, { sessionId: "a" }, 10);
    expect(heard(old)).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // A number this log never issued.
    const ahead = connect("ahead");
    subscribe("ahead", "s1", events, { sessionId: "a" }, 900);
    expect(heard(ahead)).toEqual([{ type: "q:reset", id: "s1", seq: 600 }]);

    // A number for a scope nothing was published under since the process started.
    const unknown = connect("unknown");
    subscribe("unknown", "s1", events, { sessionId: "never" }, 5);
    expect(heard(unknown)).toEqual([{ type: "q:reset", id: "s1", seq: 0 }]);
  });

  it("never replays one process's events to a subscriber of an earlier one", () => {
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });
    // The process restarts and keeps more than the subscriber had seen before it.
    _reset(1000);
    for (let n = 1; n <= 5; n++) publish(events, { sessionId: "a" }, { n });

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 2);
    expect(heard(back)).toEqual([{ type: "q:reset", id: "s1", seq: 1005 }]);
    // From there it follows the new log.
    publish(events, { sessionId: "a" }, { n: 6 });
    expect(seqs(back)).toEqual([1005, 1006]);

    // Even a scope that was quiet before the restart and is quiet after it.
    const quiet = connect("quiet");
    subscribe("quiet", "s1", events, { sessionId: "never" }, 0);
    expect(heard(quiet)).toEqual([{ type: "q:reset", id: "s1", seq: 1000 }]);
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
    expect(all).toEqual([
      { type: "q:subscribed", id: "s1" },
      { type: "q:event", id: "s1", event: "sessionEvents", data: { n: 1 } },
    ]);

    // It has no place to resume from, so a return is a reset.
    const back = connect("back");
    subscribe("back", "s1", events, {}, 1);
    expect(heard(back)).toEqual([{ type: "q:reset", id: "s1" }]);
  });

  it("lets go of the kept events of the scope published longest ago, not of its number", () => {
    for (let n = 0; n < 65; n++) publish(events, { sessionId: `s${n}` }, { n });
    // What happened in the first scope is no longer held: a return to it reads again,
    const first = connect("first");
    subscribe("first", "s1", events, { sessionId: "s0" }, 0);
    expect(heard(first)).toEqual([{ type: "q:reset", id: "s1", seq: 1 }]);
    // unless the subscriber had seen it all.
    const current = connect("current");
    subscribe("current", "s1", events, { sessionId: "s0" }, 1);
    expect(heard(current)).toEqual([]);
    const last = connect("last");
    subscribe("last", "s1", events, { sessionId: "s64" }, 0);
    expect(seqs(last)).toEqual([1]);
  });

  it("tells the followers of a scope to read again when its state changed without events", () => {
    const watching = connect("watching");
    const elsewhere = connect("elsewhere");
    publish(events, { sessionId: "a" }, { n: 1 });
    subscribe("watching", "s1", events, { sessionId: "a" });
    subscribe("elsewhere", "s1", events, { sessionId: "b" });
    subscribe("elsewhere", "all", events, {});

    resetSubscribers(events, { sessionId: "a" });

    // With where the scope stands now: what follows is delivered from there.
    expect(heard(watching)).toEqual([{ type: "q:reset", id: "s1", seq: 2 }]);
    // A subscription across scopes hears it too, without a number; another chat's does not.
    expect(heard(elsewhere)).toEqual([{ type: "q:reset", id: "all" }]);
  });

  it("tells a follower that was away during that change to read again when it returns", () => {
    connect("away");
    publish(events, { sessionId: "a" }, { n: 1 });
    subscribe("away", "s1", events, { sessionId: "a" });
    dropConnection("away");

    resetSubscribers(events, { sessionId: "a" });

    const back = connect("away");
    subscribe("away", "s1", events, { sessionId: "a" }, 1);
    expect(back).toEqual([
      { type: "q:reset", id: "s1", seq: 2 },
      { type: "q:subscribed", id: "s1", seq: 2 },
    ]);
    // One that returns after it is at the scope's position: nothing to read again.
    const later = connect("later");
    subscribe("later", "s1", events, { sessionId: "a" }, 2);
    expect(heard(later)).toEqual([]);
  });

  it("opens a subscription with the state events alone do not restate, after what was missed", () => {
    openWith(events, ({ sessionId }) => (sessionId === "a" ? [{ n: 77 }] : []));
    publish(events, { sessionId: "a" }, { n: 1 });
    publish(events, { sessionId: "a" }, { n: 2 });

    const back = connect("back");
    subscribe("back", "s1", events, { sessionId: "a" }, 1);
    expect(back).toEqual([
      { type: "q:event", id: "s1", event: "sessionEvents", data: { n: 2 }, seq: 2 },
      // Under the scope's current number: it is not an event of its own.
      { type: "q:event", id: "s1", event: "sessionEvents", data: { n: 77 }, seq: 2 },
      { type: "q:subscribed", id: "s1", seq: 2 },
    ]);
    // It is not kept: a later return is not sent it again as something missed.
    publish(events, { sessionId: "a" }, { n: 3 });
    const later = connect("later");
    subscribe("later", "s1", events, { sessionId: "a" }, 2);
    expect(numbers(later)).toEqual([3, 77]);

    // A scope with nothing to open with, and a subscription across scopes, get none.
    const other = connect("other");
    subscribe("other", "s1", events, { sessionId: "b" });
    subscribe("other", "s2", events, {});
    expect(heard(other)).toEqual([]);
  });
});
