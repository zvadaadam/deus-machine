import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { groups } from "../../../scripts/check.mjs";

const { load } = createRequire(import.meta.url)("js-yaml");
const { jobs } = load(readFileSync(".github/workflows/test.yml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ run?: string }> }>;
};

it("runs every local check group in CI", () => {
  expect(Object.keys(jobs).sort()).toEqual(Object.keys(groups).sort());
});

it.each(Object.entries(jobs))("%s runs its checks through the group", (group, { steps }) => {
  const preparation = [
    "bun install --frozen-lockfile",
    "bunx playwright install --with-deps chromium",
    "bunx node-gyp rebuild",
  ];
  const runs = steps.flatMap(({ run }) => {
    if (!run || preparation.includes(run)) return [];
    // The static FFmpeg install is shell. A check appended to it must count too.
    return run
      .trim()
      .split(/\s*(?:\n|&&|\||;)\s*/)
      .filter(
        (command) =>
          !/^(curl |echo |sha256sum |for bin |do$|gunzip |sudo install |done$)/.test(command)
      );
  });
  expect(runs).toEqual([`bun run check ${group}`]);
});
