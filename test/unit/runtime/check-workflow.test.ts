import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { groups } from "../../../scripts/check.mjs";

const { load } = createRequire(import.meta.url)("js-yaml");
const { jobs } = load(readFileSync(".github/workflows/test.yml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const preparationSteps = [
  "Install project dependencies",
  "Install relay dependencies",
  "Install FFmpeg and ffprobe",
  "Install Playwright Chromium",
  "Build node-pty",
];

it("runs every local check group in CI", () => {
  expect(Object.keys(jobs).sort()).toEqual(Object.keys(groups).sort());
});

it.each(Object.entries(jobs))("%s runs its checks through the group", (group, { steps }) => {
  const runs = steps
    .filter(({ name = "", run }) => run !== undefined && !preparationSteps.includes(name))
    .map(({ run }) => run);
  expect(runs).toEqual([`bun run check ${group}`]);
});
