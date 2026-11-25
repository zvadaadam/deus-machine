import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { groups } from "../../../scripts/check.mjs";

const { load } = createRequire(import.meta.url)("js-yaml");
const { jobs } = load(readFileSync(".github/workflows/test.yml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const preparation = [
  "bun install --frozen-lockfile",
  "bunx playwright install chromium",
  "bunx node-gyp rebuild",
];

it("runs every local check group in CI", () => {
  expect(Object.keys(jobs).sort()).toEqual(Object.keys(groups).sort());
});

it.each(Object.entries(jobs))("%s runs its checks through the group", (group, job) => {
  const checks = job.steps.filter(
    ({ name, run }) =>
      run !== undefined &&
      !preparation.includes(run) &&
      !(group === "quality" && name === "Install FFmpeg and ffprobe")
  );
  expect(checks.map(({ run }) => run)).toEqual([`bun run check ${group}`]);
  for (const required of [job, ...checks]) {
    expect(required).not.toHaveProperty("if");
    expect(required).not.toHaveProperty("continue-on-error");
  }
});
