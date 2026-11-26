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

it.each(["\t", "\0", "\ud800"])("keeps words apart around %j in a generated title", (character) => {
  expect(toTitle(`Fix${character}login`)).toBe("Fix login");
});

it("replaces each invalid character with a space before trimming and cutting the first line", () => {
  const prefix = "🌱".repeat(117);
  expect(toTitle(`\0 ${prefix}\t\ud800X\0extra`)).toBe(prefix + "  X");
  expect(toTitle("\0 \t\udc00\nSecond line")).toBeNull();
});
