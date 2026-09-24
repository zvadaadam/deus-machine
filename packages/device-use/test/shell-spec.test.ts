import { describe, expect, test } from "bun:test";
import { PHONE_INSETS, TABLET_INSETS, getShellSpec } from "../src/frontend/lib/shell-spec.js";
import type { ShellSpec } from "../src/frontend/lib/shell-spec.js";

/** Recompute the displayed screen-box aspect ratio that a given shell spec
 *  produces, by replaying the CSS geometry from `styles.css`:
 *    .device-shell has inline `aspect-ratio: <shellAR>`  => shellW/shellH = shellAR
 *    .device-screen is absolutely positioned with % insets
 *      => screenW = shellW * widthFrac, screenH = shellH * heightFrac
 *  So the displayed screen aspect ratio is:
 *    displayedAR = screenW / screenH = shellAR * widthFrac / heightFrac
 *  Per the design intent ("no stretching"), this MUST equal the stream AR. */
function displayedScreenAR(spec: ShellSpec, insets: typeof PHONE_INSETS): number {
  const shellAR = Number.parseFloat(spec.aspectRatio);
  const widthFrac = 1 - (insets.left + insets.right) / 100;
  const heightFrac = 1 - (insets.top + insets.bottom) / 100;
  return (shellAR * widthFrac) / heightFrac;
}

const PHONE_SIZES: Array<{ name: string; ptW: number; ptH: number }> = [
  { name: "iPhone 17 Pro Max", ptW: 440, ptH: 956 },
  { name: "iPhone 16", ptW: 393, ptH: 852 },
];

const TABLET_SIZES: Array<{ name: string; ptW: number; ptH: number }> = [
  { name: "iPad Pro 11", ptW: 834, ptH: 1194 },
  { name: "iPad Air (landscape)", ptW: 1180, ptH: 820 },
];

describe("getShellSpec — screen-box aspect-ratio invariant", () => {
  for (const { name, ptW, ptH } of PHONE_SIZES) {
    test(`phone (${name}, ${ptW}×${ptH}): displayed screen AR matches the stream`, () => {
      const streamAR = ptW / ptH;
      const spec = getShellSpec(name, { ptW, ptH });
      expect(displayedScreenAR(spec, PHONE_INSETS)).toBeCloseTo(streamAR, 10);
    });
  }

  for (const { name, ptW, ptH } of TABLET_SIZES) {
    test(`tablet (${name}, ${ptW}×${ptH}): displayed screen AR matches the stream`, () => {
      const streamAR = ptW / ptH;
      const spec = getShellSpec(`iPad Pro ${name}`, { ptW, ptH });
      expect(displayedScreenAR(spec, TABLET_INSETS)).toBeCloseTo(streamAR, 10);
    });
  }

  test("fallback phone size (no streamInfo.size) still satisfies the invariant", () => {
    const streamAR = 430 / 932;
    const spec = getShellSpec("iPhone", undefined);
    expect(displayedScreenAR(spec, PHONE_INSETS)).toBeCloseTo(streamAR, 10);
  });

  test("fallback tablet size (no streamInfo.size) still satisfies the invariant", () => {
    const streamAR = 834 / 1194;
    const spec = getShellSpec("iPad Pro", undefined);
    expect(displayedScreenAR(spec, TABLET_INSETS)).toBeCloseTo(streamAR, 10);
  });

  test("null device name defaults to phone fallback size", () => {
    const spec = getShellSpec(null, undefined);
    expect(displayedScreenAR(spec, PHONE_INSETS)).toBeCloseTo(430 / 932, 10);
  });
});

describe("getShellSpec — inverted-formula regression guard", () => {
  test("iPhone 17 Pro Max shellAR matches the CORRECTED formula, not the buggy one", () => {
    const streamAR = 440 / 956;
    const widthFrac = 1 - (PHONE_INSETS.left + PHONE_INSETS.right) / 100; // 0.95
    const heightFrac = 1 - (PHONE_INSETS.top + PHONE_INSETS.bottom) / 100; // 0.964

    const corrected = (streamAR * heightFrac) / widthFrac; // ≈ 0.46703
    const buggy = (streamAR * widthFrac) / heightFrac; // ≈ 0.45357

    const spec = getShellSpec("iPhone 17 Pro Max", { ptW: 440, ptH: 956 });
    const shellAR = Number.parseFloat(spec.aspectRatio);

    expect(shellAR).toBeCloseTo(corrected, 10);
    // Explicit guard: the value must not regress to the inverted ratio.
    expect(shellAR).not.toBeCloseTo(buggy, 4);
  });
});

describe("getShellSpec — device classification + return shape", () => {
  test("deviceName containing 'iPad' is classified as a tablet", () => {
    const spec = getShellSpec("iPad Pro 13", { ptW: 1064, ptH: 1376 });
    expect(spec.screenInsets.top).toBe(`${TABLET_INSETS.top}%`);
    expect(spec.screenInsets.left).toBe(`${TABLET_INSETS.left}%`);
    expect(spec.screenInsets.right).toBe(`${TABLET_INSETS.right}%`);
    expect(spec.screenInsets.bottom).toBe(`${TABLET_INSETS.bottom}%`);
    expect(spec.shellRadius).toBe("2.75rem");
    expect(spec.screenRadius).toBe("2.1rem");
  });

  test("iPhone deviceName is classified as a phone", () => {
    const spec = getShellSpec("iPhone 17 Pro Max", { ptW: 440, ptH: 956 });
    expect(spec.screenInsets.top).toBe(`${PHONE_INSETS.top}%`);
    expect(spec.screenInsets.left).toBe(`${PHONE_INSETS.left}%`);
    expect(spec.screenInsets.right).toBe(`${PHONE_INSETS.right}%`);
    expect(spec.screenInsets.bottom).toBe(`${PHONE_INSETS.bottom}%`);
    expect(spec.shellRadius).toBe("3.25rem");
    expect(spec.screenRadius).toBe("2.6rem");
  });

  test("null/undefined deviceName is treated as a phone (not tablet)", () => {
    expect(getShellSpec(null, undefined).shellRadius).toBe("3.25rem");
    expect(getShellSpec(undefined, undefined).shellRadius).toBe("3.25rem");
  });

  test("aspectRatio is a finite, positive, parseable numeric string", () => {
    const parsed = Number.parseFloat(
      getShellSpec("iPhone 17 Pro Max", { ptW: 440, ptH: 956 }).aspectRatio
    );
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);
  });

  test("supplied stream size overrides the fallback aspect ratio", () => {
    // Guards against the size argument being silently ignored.
    const fallback = getShellSpec("iPhone", undefined);
    const streamed = getShellSpec("iPhone", { ptW: 440, ptH: 956 });
    expect(Number.parseFloat(streamed.aspectRatio)).not.toBeCloseTo(
      Number.parseFloat(fallback.aspectRatio),
      6
    );
  });
});
