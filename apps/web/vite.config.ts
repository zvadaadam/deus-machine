/**
 * Vite config for standalone web mode (browser-only, no Electron).
 * Used by `bun run dev:web` / `bun run dev:frontend`.
 *
 * Mirrors the renderer section of electron.vite.config.ts.
 */

import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { readFileSync } from "fs";

const root = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));

export default defineConfig({
  root: __dirname,
  plugins: [react(), svgr(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@/app": resolve(__dirname, "src/app"),
      "@/features": resolve(__dirname, "src/features"),
      "@/platform": resolve(__dirname, "src/platform"),
      "@/shared": resolve(__dirname, "src/shared"),
      "@/components": resolve(__dirname, "src/components"),
      "@/lib": resolve(__dirname, "src/shared/lib"),
      "@/hooks": resolve(__dirname, "src/shared/hooks"),
      "@/ui": resolve(__dirname, "src/components/ui"),
      "@shared": resolve(root, "shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    sourcemap: "hidden",
    outDir: resolve(root, "out/renderer"),
  },
  server: {
    port: 1420,
    watch: {
      ignored: ["**/.opendevs/**"],
    },
  },
});
