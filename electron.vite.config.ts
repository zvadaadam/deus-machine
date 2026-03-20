import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
  // ---------------------------------------------------------------------------
  // Main process (apps/desktop/main/)
  // ---------------------------------------------------------------------------
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "apps/desktop/main/index.ts"),
        },
        external: ["better-sqlite3", "node-pty"],
      },
      outDir: "out/main",
    },
  },

  // ---------------------------------------------------------------------------
  // Preload scripts (apps/desktop/preload/)
  // ---------------------------------------------------------------------------
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "apps/desktop/preload/index.ts"),
          "browser-preload": resolve(__dirname, "apps/desktop/preload/browser-preload.ts"),
        },
      },
      outDir: "out/preload",
    },
  },

  // ---------------------------------------------------------------------------
  // Renderer (apps/web/) — React app
  // ---------------------------------------------------------------------------
  renderer: {
    root: resolve(__dirname, "apps/web"),
    plugins: [react(), svgr(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "apps/web/src"),
        "@/app": resolve(__dirname, "apps/web/src/app"),
        "@/features": resolve(__dirname, "apps/web/src/features"),
        "@/platform": resolve(__dirname, "apps/web/src/platform"),
        "@/shared": resolve(__dirname, "apps/web/src/shared"),
        "@/components": resolve(__dirname, "apps/web/src/components"),
        "@/lib": resolve(__dirname, "apps/web/src/shared/lib"),
        "@/hooks": resolve(__dirname, "apps/web/src/shared/hooks"),
        "@/ui": resolve(__dirname, "apps/web/src/components/ui"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    build: {
      chunkSizeWarningLimit: 2000,
      sourcemap: "hidden",
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: resolve(__dirname, "apps/web/index.html"),
      },
    },
    server: {
      port: 1420,
      watch: {
        ignored: ["**/.opendevs/**"],
      },
    },
  },
});
