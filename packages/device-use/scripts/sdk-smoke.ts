#!/usr/bin/env bun
import { session } from "../src/sdk/index.js";

const ctx = await session("iPhone 17")
  .app("Maps")
  .wait(1500)
  .snapshot()
  .do(async (c) => {
    console.log(`[sdk] booted on ${c.udid}`);
    console.log(`[sdk] ${c.entries.length} interactive elements after snapshot`);
    const searchField = c.entries.find((e) => e.type === "SearchField" || e.label === "Search");
    if (searchField) console.log(`[sdk] search field at ${searchField.ref}`);
  })
  .screenshot("/tmp/mu-sdk-maps.png")
  .run();

console.log("\n[sdk] step log:");
for (const log of ctx.log) {
  console.log(`  ${log.step.padEnd(30)} ${log.durationMs}ms`);
}
