import { expect, it } from "vitest";
import { toTitle } from "@shared/title";

it.each(["\n", "\r\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
  "uses only the first line of a generated title (%j)",
  (separator) => {
    expect(toTitle(`  First line  ${separator}Second line`)).toBe("First line");
    expect(toTitle(`  ${separator}Second line`)).toBeNull();
  }
);

it("cuts a generated title at 120 characters and trims the result", () => {
  const title = "🌱".repeat(120);
  expect(toTitle(`  ${title}more  `)).toBe(title);
  expect(toTitle("a".repeat(119) + " b")).toBe("a".repeat(119));
  expect(toTitle("")).toBeNull();
});
