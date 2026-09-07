import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "apps/web/src"),
      "@shared": path.resolve(projectRoot, "shared"),
    },
  },
  test: {
    root: __dirname,
    environment: "happy-dom",
    include: ["unit/terminal/Terminal-render.test.tsx"],
    globals: true,
    testTimeout: 20000,
  },
});
