import { describe, expect, it } from "vitest";

import { buildCliEnv } from "../src/lib/cli.ts";

describe("buildCliEnv", () => {
  it("uses per-call CLI key overrides without mutating process.env", () => {
    const previous = process.env.PENCIL_CLI_KEY;
    delete process.env.PENCIL_CLI_KEY;

    try {
      const env = buildCliEnv({ PENCIL_CLI_KEY: "pencil_cli_test" });
      expect(env.PENCIL_CLI_KEY).toBe("pencil_cli_test");
      expect(process.env.PENCIL_CLI_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PENCIL_CLI_KEY;
      else process.env.PENCIL_CLI_KEY = previous;
    }
  });

  it("pins local API and development NODE_ENV to production defaults", () => {
    const env = buildCliEnv({
      PENCIL_API_BASE: "http://localhost:3001",
      NODE_ENV: "development",
    });

    expect(env.PENCIL_API_BASE).toBe("https://api.pencil.dev");
    expect(env.NODE_ENV).toBe("production");
  });
});
