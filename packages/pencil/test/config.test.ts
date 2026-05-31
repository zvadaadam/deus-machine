import { describe, expect, it } from "vitest";

import { pencilHostAppNameFor } from "../src/lib/config.ts";

describe("pencilHostAppNameFor", () => {
  it("derives stable, filesystem-safe host names", () => {
    expect(
      pencilHostAppNameFor({
        workspace: "/repos/app",
        storage: "/repos/app/.pencil",
        port: 4321,
      })
    ).toMatch(/^deus-[a-f0-9]{16}$/);
    expect(
      pencilHostAppNameFor({
        workspace: "/repos/app",
        storage: "/repos/app/.pencil",
        port: 4321,
      })
    ).toBe(
      pencilHostAppNameFor({
        workspace: "/repos/app",
        storage: "/repos/app/.pencil",
        port: 4321,
      })
    );
  });

  it("uses different registry names for concurrently running workspace instances", () => {
    const first = pencilHostAppNameFor({
      workspace: "/repos/app-a",
      storage: "/repos/app-a/.pencil",
      port: 4321,
    });
    const second = pencilHostAppNameFor({
      workspace: "/repos/app-b",
      storage: "/repos/app-b/.pencil",
      port: 4322,
    });

    expect(first).not.toBe(second);
  });
});
