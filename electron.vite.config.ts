import { resolve, join } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import type { Plugin } from "vite";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

/**
 * Vite plugin: serves the backend port file so Chrome tabs (without electronAPI)
 * can discover the backend port during Electron dev mode.
 *
 * The Electron main process writes the port to a temp file after the backend starts.
 * This middleware serves it at /__backend_port so the renderer can fetch it.
 */
function backendPortPlugin(): Plugin {
  return {
    name: "deus-backend-port",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/__backend_port") {
          const portFile = join(tmpdir(), "deus-backend-port");
          try {
            if (existsSync(portFile)) {
              const port = readFileSync(portFile, "utf-8").trim();
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.end(JSON.stringify({ port: parseInt(port, 10) }));
              return;
            }
          } catch {
            // Port file not readable — fall through to 503
          }
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "Backend not started yet" }));
          return;
        }
        next();
      });
    },
  };
}

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
        external: [
          "better-sqlite3",
          "node-pty",
          // `ws` has optional native peer deps (`bufferutil`, `utf-8-validate`).
          // Keep it external so Node resolves them at runtime instead of Vite
          // inlining a stub that throws during Electron startup.
          "ws",
          "agent-simulator",
          "agent-simulator/engine",
        ],
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
    plugins: [react(), svgr(), tailwindcss(), backendPortPlugin()],
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
        ignored: ["**/.deus/**"],
      },
    },
  },
});
