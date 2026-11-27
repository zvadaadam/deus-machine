import { expect, it } from "vitest";
import { boardOptions } from "@/features/board/options";

it.each([
  ["1. One\n2. Two", ["One", "Two"]],
  ["1) One\n2) Two\n3) Three\n4) Four\n5) Five", ["One", "Two", "Three", "Four", "Five"]],
  ["1. One", []],
  ["```md\n1. One\n2. Two\n```", []],
  ["~~~~\n1. One\n2. Two\n~~~\n3. Still code", []],
  ["1. Lone\n\n1. **One**\n2. `Two`", ["**One**", "`Two`"]],
] as const)("recognizes consecutive options in %j", (body, choices) => {
  expect(boardOptions(body)?.options.map((o) => o.text) ?? []).toEqual(choices);
});

it.each([
  "1. Deploy now\n2. Wait\n   until the checks pass",
  "1. Review the changes\n   - Check the logs\n2. Deploy now\n3. Stop",
  "1. Approve\n2. Wait\n3. Run this\n   ```sh\n   check\n   ```",
  "1. Approve\n2. Wait\nuntil the checks pass",
])("keeps the whole run as Markdown when an option spans multiple lines in %j", (body) => {
  expect(boardOptions(body)).toBeNull();
});

it("keeps the text on either side, including a second run of numbered lines", () => {
  const before = "@you Choose a shipment.";
  const after = "\nEverything else continues.\n\n1. Check the logs\n2. File the report";
  expect(boardOptions([before, "1) Retail", "2) Bulk", after].join("\n"))).toEqual({
    before,
    references: "",
    after,
    options: [
      { number: "1", text: "Retail" },
      { number: "2", text: "Bulk" },
    ],
  });
});

it("keeps reference definitions available to the question text and the option labels", () => {
  const definition = "[report]: .context/report.md";
  const choices = boardOptions(
    `@you Read [the report][report].\n1. Keep **[it][report]**\n2. Drop it\n\n${definition}`
  );
  expect(choices?.references).toContain(definition);
});
