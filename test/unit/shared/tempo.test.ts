import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { tempo } from "@/shared/lib/tempo";

it("keeps Framer Motion's seconds and easing curves equal to the CSS tempo tokens", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../apps/web/src/global.css"), "utf8");
  const property = (name: string) => css.match(new RegExp(`--${name}: ([^;]+);`))?.[1];
  for (const tier of ["fast", "moderate", "slow"] as const) {
    const enter = tempo[tier];
    expect(property(`tempo-${tier}`)).toBe(`${enter.duration * 1000}ms`);
    expect(property(`tempo-${tier}-exit`)).toBe(`${enter.exit.duration * 1000}ms`);
    expect(property("tempo-ease")).toBe(`cubic-bezier(${enter.ease.join(", ")})`);
    expect(enter.exit.ease).toEqual(enter.ease);
    expect(enter.layout.duration).toBe(enter.duration);
    expect(property("ease-move")).toBe(`cubic-bezier(${enter.layout.ease.join(", ")})`);
  }
  expect(property("tempo-step")).toBe(`${tempo.step * 1000}ms`);
});
