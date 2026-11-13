import { describe, expect, it } from "vitest";
import { api, ops, streams } from "@shared/api";
import { registry } from "../../../src/api";

/**
 * The contract (shared/api) and the handlers (src/api) are two lists of the
 * same operations. These hold them together: an operation a client can call
 * with nothing to answer it, or a handler for something no client can name,
 * fails here instead of at runtime.
 */
describe("the operation contract", () => {
  it("names every operation and stream once: a subscription says one name for either", () => {
    const names = [...ops, ...streams].map((declared) => declared.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it("has a handler for every declared operation, and no handler for anything else", () => {
    const declared = ops.map((op) => op.name).sort();
    expect(registry.names().sort()).toEqual(declared);
    for (const op of ops) expect(registry.find(op.name)).toBe(op);
  });

  it("exports nothing from the contract that is not an operation or a stream", () => {
    expect(Object.keys(api)).toHaveLength(ops.length + streams.length);
  });

  it("exports every operation and stream under the name it has on the wire", () => {
    for (const [key, declared] of Object.entries(api)) expect(declared.name).toBe(key);
  });

  it("only lets reads be subscribed to", () => {
    expect(ops.filter((op) => op.live && op.kind !== "read")).toEqual([]);
  });
});
