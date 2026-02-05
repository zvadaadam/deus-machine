import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: __dirname,
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
    testTimeout: 15000,
    setupFiles: ["./test/setup.ts"],
  },
});
