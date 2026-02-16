import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Load .env from project root so E2E tests can pick up API keys
  envDir: path.resolve(__dirname, ".."),
  test: {
    root: __dirname,
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
    testTimeout: 15000,
    setupFiles: ["./test/setup.ts"],
  },
});
