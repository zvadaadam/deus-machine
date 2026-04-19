import { describe, expect, it } from "vitest";

import {
  substituteArgs,
  substituteEnv,
  substituteTemplate,
  type TemplateVars,
} from "@shared/aap/template";

const VARS: TemplateVars = {
  port: 47831,
  workspace: "/repos/my-app",
  userData: "/Users/me/Library/Application Support/com.deus.app",
  storage: {
    workspace: "/repos/my-app/.deus/apps/deus.mobile-use",
    global: "/Users/me/Library/Application Support/com.deus.app/apps/deus.mobile-use",
  },
};

describe("shared/aap/template", () => {
  describe("substituteTemplate", () => {
    it("substitutes a single top-level var", () => {
      expect(substituteTemplate("--port={port}", VARS)).toBe("--port=47831");
    });

    it("substitutes nested dotted vars", () => {
      expect(substituteTemplate("{storage.workspace}/state.json", VARS)).toBe(
        "/repos/my-app/.deus/apps/deus.mobile-use/state.json"
      );
    });

    it("substitutes multiple vars in one string", () => {
      expect(substituteTemplate("{workspace}:{port}", VARS)).toBe("/repos/my-app:47831");
    });

    it("passes literal text through", () => {
      expect(substituteTemplate("no templates here", VARS)).toBe("no templates here");
    });

    it("does not match non-identifier bracket content (JSON-like stays literal)", () => {
      // `{"foo": 1}` shouldn't be treated as a template — the regex requires an identifier.
      expect(substituteTemplate('{"foo": 1}', VARS)).toBe('{"foo": 1}');
    });

    it("throws on unknown variable", () => {
      expect(() => substituteTemplate("{nope}", VARS)).toThrow(/nope/);
    });

    it("throws on unresolved nested path", () => {
      expect(() => substituteTemplate("{storage.nope}", VARS)).toThrow(/storage\.nope/);
    });

    it("throws when a nested namespace is missing entirely", () => {
      const empty: TemplateVars = { port: 1234 };
      expect(() => substituteTemplate("{storage.workspace}", empty)).toThrow(/storage\.workspace/);
    });

    it("numeric values are stringified", () => {
      expect(substituteTemplate("{port}", { port: 0 })).toBe("0");
    });

    it("does not traverse the prototype chain (constructor, toString, etc.)", () => {
      // {constructor} must not silently resolve to `Object` via prototype access.
      expect(() => substituteTemplate("{constructor}", {})).toThrow(/constructor/);
      expect(() => substituteTemplate("{constructor.name}", {})).toThrow(/constructor/);
      expect(() => substituteTemplate("{toString}", {})).toThrow(/toString/);
    });
  });

  describe("substituteArgs", () => {
    it("substitutes each arg independently", () => {
      expect(substituteArgs(["serve", "--port", "{port}", "--cwd", "{workspace}"], VARS)).toEqual([
        "serve",
        "--port",
        "47831",
        "--cwd",
        "/repos/my-app",
      ]);
    });

    it("throws if any arg uses an unknown var", () => {
      expect(() => substituteArgs(["--flag", "{nope}"], VARS)).toThrow();
    });
  });

  describe("substituteEnv", () => {
    it("substitutes each env value", () => {
      expect(
        substituteEnv(
          { DEUS_STORAGE: "{storage.workspace}", DEUS_PORT: "{port}", STATIC: "literal" },
          VARS
        )
      ).toEqual({
        DEUS_STORAGE: "/repos/my-app/.deus/apps/deus.mobile-use",
        DEUS_PORT: "47831",
        STATIC: "literal",
      });
    });

    it("does not substitute keys, only values", () => {
      // The key `{port}` should pass through as-is (weird but documented).
      const out = substituteEnv({ "{port}": "value-{port}" }, VARS);
      expect(out).toEqual({ "{port}": "value-47831" });
    });
  });
});
