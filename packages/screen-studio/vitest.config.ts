import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The pipeline and renderer tests encode real video with ffmpeg, which
    // runs well past the 5s default on CI runners.
    testTimeout: 30_000,
  },
});
