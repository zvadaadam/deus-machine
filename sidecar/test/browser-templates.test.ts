// sidecar/test/browser-templates.test.ts
// Tests that browser automation JS templates produce valid IIFEs.
//
// The root cause of the "JSON Parse error: Unexpected identifier undefined"
// bug was that templates returned multi-statement JS blocks (not IIFEs),
// and the evalWithResult wrapper's `return ${js}` triggered JavaScript's
// Automatic Semicolon Insertion (ASI) — silently returning undefined.
//
// These tests ensure every template is a properly-formed IIFE that, when
// evaluated, returns a value (not undefined). Run via `bun run test:sidecar`.

import { describe, it, expect } from "vitest";

// Import templates directly — they're pure functions with no platform deps
import {
  SNAPSHOT_JS,
  CONSOLE_MESSAGES_JS,
  NETWORK_REQUESTS_JS,
  buildClickJs,
  buildTypeJs,
  buildHoverJs,
  buildPressKeyJs,
  buildSelectOptionJs,
  buildEvaluateJs,
  buildWaitForTextJs,
  buildWaitForTextGoneJs,
} from "../../src/features/browser/automation/browser-utils";

import {
  VISUAL_EFFECTS_SETUP,
  buildMoveCursorAndRippleJs,
  buildPinCursorJs,
  HIDE_CURSOR_JS,
} from "../../src/features/browser/automation/visual-effects";

// ========================================================================
// Helpers
// ========================================================================

/** Check that a JS string is a self-invoking function expression.
 *  Accepts both classic IIFEs `(function(){...})()` and arrow IIFEs
 *  `(() => {...})()` — esbuild's `format: "iife"` emits the latter. */
function assertIsIIFE(js: string, name: string) {
  const trimmed = js.trim();
  // esbuild may prepend "use strict"; — strip it for the shape check
  const body = trimmed.replace(/^"use strict";\s*/, "");
  expect(body, `${name} should start with (function or (() =>`).toMatch(/^\((?:function\s*\(|(?:\(\)\s*=>))/);
  expect(trimmed, `${name} should end with )()`).toMatch(/\)\(\)\s*;?\s*$/);
}

/** Check that a JS string contains `return` before a JSON.stringify call */
function assertHasReturnJson(js: string, name: string) {
  // All non-Promise templates should have at least one `return JSON.stringify(`
  expect(js, `${name} should have return JSON.stringify`).toContain("return JSON.stringify(");
}

/**
 * Simulate evalWithResult's wrapping behavior to check for ASI bugs.
 *
 * The real wrapper does:
 *   var __result = ${js};
 *   return typeof __result === 'string' ? __result : String(__result);
 *
 * If ${js} is multi-statement (not an IIFE), `var __result = <first-stmt>`
 * would only capture the first statement's value, losing the actual result.
 * With a proper IIFE, `var __result = (function(){...})()` works correctly.
 */
function assertSafeForEvalWrapper(js: string, name: string) {
  // After `var __result = `, the JS engine needs a single expression.
  // An IIFE `(function(){...})()` is a single expression.
  // Multi-statement code like `var x = 1; x + 2` would only assign `var x = 1`
  // to __result, silently losing the rest.
  const trimmed = js.trim();
  // First non-whitespace character after template start should be '(' (IIFE start)
  expect(trimmed[0], `${name} first char should be '(' (IIFE start)`).toBe("(");
}

// ========================================================================
// Tests: browser-utils.ts templates
// ========================================================================

describe("browser-utils JS templates", () => {
  describe("SNAPSHOT_JS", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(SNAPSHOT_JS, "SNAPSHOT_JS");
    });

    it("returns JSON.stringify result", () => {
      assertHasReturnJson(SNAPSHOT_JS, "SNAPSHOT_JS");
    });

    it("is safe for evalWithResult wrapper (no ASI risk)", () => {
      assertSafeForEvalWrapper(SNAPSHOT_JS, "SNAPSHOT_JS");
    });

    it("includes BROWSER_UTILS functions", () => {
      expect(SNAPSHOT_JS).toContain("buildPageSnapshot");
      expect(SNAPSHOT_JS).toContain("accessibilityTreeToYaml");
    });

    it("returns snapshot, url, and title", () => {
      expect(SNAPSHOT_JS).toContain("snapshot:");
      expect(SNAPSHOT_JS).toContain("window.location.href");
      expect(SNAPSHOT_JS).toContain("document.title");
    });
  });

  describe("CONSOLE_MESSAGES_JS", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(CONSOLE_MESSAGES_JS, "CONSOLE_MESSAGES_JS");
    });

    it("returns JSON.stringify result", () => {
      assertHasReturnJson(CONSOLE_MESSAGES_JS, "CONSOLE_MESSAGES_JS");
    });
  });

  describe("NETWORK_REQUESTS_JS", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(NETWORK_REQUESTS_JS, "NETWORK_REQUESTS_JS");
    });

    it("returns JSON.stringify result", () => {
      assertHasReturnJson(NETWORK_REQUESTS_JS, "NETWORK_REQUESTS_JS");
    });
  });

  describe("buildClickJs", () => {
    it("is a valid IIFE", () => {
      const js = buildClickJs("ref-123");
      assertIsIIFE(js, "buildClickJs");
    });

    it("returns JSON on element not found", () => {
      const js = buildClickJs("ref-missing");
      assertHasReturnJson(js, "buildClickJs");
      expect(js).toContain("Element not found");
    });

    it("is safe for evalWithResult wrapper", () => {
      assertSafeForEvalWrapper(buildClickJs("ref-123"), "buildClickJs");
    });

    it("supports doubleClick option", () => {
      const js = buildClickJs("ref-123", true);
      expect(js).toContain("doubleClick: true");
    });
  });

  describe("buildTypeJs", () => {
    it("is a valid IIFE", () => {
      const js = buildTypeJs("ref-123", "hello");
      assertIsIIFE(js, "buildTypeJs");
    });

    it("returns JSON", () => {
      assertHasReturnJson(buildTypeJs("ref-123", "hello"), "buildTypeJs");
    });

    it("properly escapes text content", () => {
      const js = buildTypeJs("ref-123", 'hello "world"');
      expect(js).toContain('\\"world\\"');
    });

    it("supports submit option", () => {
      const js = buildTypeJs("ref-123", "hello", true);
      expect(js).toContain("submit: true");
    });
  });

  describe("buildHoverJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildHoverJs("ref-123"), "buildHoverJs");
    });

    it("returns JSON", () => {
      assertHasReturnJson(buildHoverJs("ref-123"), "buildHoverJs");
    });

    it("dispatches mouseenter, mouseover, mousemove events", () => {
      const js = buildHoverJs("ref-123");
      expect(js).toContain("mouseenter");
      expect(js).toContain("mouseover");
      expect(js).toContain("mousemove");
    });
  });

  describe("buildPressKeyJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildPressKeyJs("Enter"), "buildPressKeyJs");
    });

    it("returns JSON", () => {
      assertHasReturnJson(buildPressKeyJs("Enter"), "buildPressKeyJs");
    });

    it("supports modifier keys", () => {
      const js = buildPressKeyJs("a", { ctrl: true, shift: true });
      expect(js).toContain("ctrlKey: true");
      expect(js).toContain("shiftKey: true");
    });
  });

  describe("buildSelectOptionJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildSelectOptionJs("ref-123", ["opt1"]), "buildSelectOptionJs");
    });

    it("returns JSON", () => {
      assertHasReturnJson(buildSelectOptionJs("ref-123", ["opt1"]), "buildSelectOptionJs");
    });

    it("handles multiple values", () => {
      const js = buildSelectOptionJs("ref-123", ["a", "b", "c"]);
      expect(js).toContain('"a"');
      expect(js).toContain('"b"');
      expect(js).toContain('"c"');
    });
  });

  describe("buildEvaluateJs", () => {
    it("is a valid IIFE (without ref)", () => {
      assertIsIIFE(buildEvaluateJs("return document.title"), "buildEvaluateJs");
    });

    it("is a valid IIFE (with ref)", () => {
      assertIsIIFE(
        buildEvaluateJs("return element.textContent", "ref-123"),
        "buildEvaluateJs(ref)"
      );
    });

    it("handles async results (Promises)", () => {
      const js = buildEvaluateJs("return fetch('/api').then(r => r.json())");
      expect(js).toContain("result.then");
    });

    it("includes BROWSER_UTILS inside the IIFE", () => {
      const js = buildEvaluateJs("return 1");
      const iifeStart = js.indexOf("(function(){");
      const utilsStart = js.indexOf("buildPageSnapshot");
      expect(iifeStart).toBeLessThan(utilsStart);
    });
  });

  describe("buildWaitForTextJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildWaitForTextJs("loading"), "buildWaitForTextJs");
    });

    it("returns a Promise (for async polling)", () => {
      const js = buildWaitForTextJs("loading");
      expect(js).toContain("return new Promise");
    });

    it("includes BROWSER_UTILS inside the IIFE", () => {
      const js = buildWaitForTextJs("loading");
      const iifeStart = js.indexOf("(function(){");
      const utilsStart = js.indexOf("buildPageSnapshot");
      expect(iifeStart).toBeLessThan(utilsStart);
    });

    it("uses custom timeout", () => {
      const js = buildWaitForTextJs("loading", 5000);
      expect(js).toContain("5000");
    });
  });

  describe("buildWaitForTextGoneJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildWaitForTextGoneJs("spinner"), "buildWaitForTextGoneJs");
    });

    it("returns a Promise", () => {
      const js = buildWaitForTextGoneJs("spinner");
      expect(js).toContain("return new Promise");
    });
  });
});

// ========================================================================
// Tests: visual-effects.ts templates
// ========================================================================

describe("visual-effects JS templates", () => {
  describe("VISUAL_EFFECTS_SETUP", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(VISUAL_EFFECTS_SETUP, "VISUAL_EFFECTS_SETUP");
    });

    it("installs window.__opendevsVisuals", () => {
      expect(VISUAL_EFFECTS_SETUP).toContain("window.__opendevsVisuals");
    });
  });

  describe("buildMoveCursorAndRippleJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildMoveCursorAndRippleJs("ref-123"), "buildMoveCursorAndRippleJs");
    });

    it("returns JSON with duration", () => {
      const js = buildMoveCursorAndRippleJs("ref-123");
      assertHasReturnJson(js, "buildMoveCursorAndRippleJs");
      expect(js).toContain("duration");
    });
  });

  describe("buildPinCursorJs", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(buildPinCursorJs("ref-123"), "buildPinCursorJs");
    });

    it("returns JSON with duration", () => {
      const js = buildPinCursorJs("ref-123");
      assertHasReturnJson(js, "buildPinCursorJs");
      expect(js).toContain("duration");
    });
  });

  describe("HIDE_CURSOR_JS", () => {
    it("is a valid IIFE", () => {
      assertIsIIFE(HIDE_CURSOR_JS, "HIDE_CURSOR_JS");
    });
  });
});

// ========================================================================
// Tests: evalWithResult wrapper safety
// ========================================================================

describe("evalWithResult wrapper compatibility", () => {
  // Simulate the exact wrapper pattern from eval-with-result.ts
  function simulateWrapping(js: string): string {
    return `(function(){
    try {
      var __result = ${js};
      if (__result && typeof __result === 'object' && typeof __result.then === 'function') {
        return '__OPENDEVS_ASYNC__';
      }
      return typeof __result === 'string' ? __result : String(__result);
    } catch(__e) {
      return JSON.stringify({error: __e.message || String(__e)});
    }
  })()`;
  }

  const templates = [
    { name: "SNAPSHOT_JS", js: SNAPSHOT_JS },
    { name: "CONSOLE_MESSAGES_JS", js: CONSOLE_MESSAGES_JS },
    { name: "NETWORK_REQUESTS_JS", js: NETWORK_REQUESTS_JS },
    { name: "buildClickJs", js: buildClickJs("ref-test") },
    { name: "buildTypeJs", js: buildTypeJs("ref-test", "hello") },
    { name: "buildHoverJs", js: buildHoverJs("ref-test") },
    { name: "buildPressKeyJs", js: buildPressKeyJs("Enter") },
    {
      name: "buildSelectOptionJs",
      js: buildSelectOptionJs("ref-test", ["a"]),
    },
    { name: "buildEvaluateJs", js: buildEvaluateJs("return 1") },
    {
      name: "buildEvaluateJs(ref)",
      js: buildEvaluateJs("return element.textContent", "ref-test"),
    },
    { name: "buildWaitForTextJs", js: buildWaitForTextJs("text") },
    { name: "buildWaitForTextGoneJs", js: buildWaitForTextGoneJs("text") },
    {
      name: "buildMoveCursorAndRippleJs",
      js: buildMoveCursorAndRippleJs("ref-test"),
    },
    { name: "buildPinCursorJs", js: buildPinCursorJs("ref-test") },
  ];

  for (const { name, js } of templates) {
    it(`${name}: wrapped code is syntactically valid`, () => {
      const wrapped = simulateWrapping(js);
      // The wrapped code should parse without SyntaxError.
      // We can't fully eval it (no DOM), but we can check that
      // `new Function()` doesn't throw a SyntaxError.
      expect(() => new Function(wrapped)).not.toThrow();
    });

    it(`${name}: no ASI risk — assignment target is a single expression`, () => {
      // The critical pattern: `var __result = ${js};`
      // If ${js} is an IIFE `(function(){...})()`, the `(` after `=\n` is
      // parsed as the start of an expression (no ASI — `=` always expects
      // an initializer). But if ${js} starts with a function declaration
      // or multi-statement code, `var __result = <first-stmt>` would lose
      // the actual result.
      const trimmed = js.trim();
      expect(
        trimmed.startsWith("("),
        `${name}: should start with '(' to be a single expression`
      ).toBe(true);
    });
  }
});
