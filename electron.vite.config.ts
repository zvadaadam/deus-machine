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
 * Build targets for the installed Electron. electron-vite derives them from a
 * table that ends at Electron 35 and quietly uses 35's for any newer major, so
 * they are named here, and an Electron this table lacks stops the build.
 * `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/.../Electron -p process.versions`
 * prints the node and chrome versions of a new one.
 */
const ELECTRON_TARGETS: Record<string, { node: string; chrome: string }> = {
  "45": { node: "node24.22", chrome: "chrome156" },
};
const electronMajor = JSON.parse(
  readFileSync(resolve(__dirname, "node_modules/electron/package.json"), "utf-8")
).version.split(".")[0];
const targets = ELECTRON_TARGETS[electronMajor];
if (!targets) {
  throw new Error(
    `electron.vite.config.ts has no build targets for Electron ${electronMajor}; add them to ELECTRON_TARGETS.`
  );
}

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
              // Same-origin only: no CORS header, so another site cannot read the port.
              res.setHeader("Content-Type", "application/json");
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
      target: targets.node,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "apps/desktop/main/index.ts"),
        },
      },
      outDir: "out/main",
    },
  },

  // ---------------------------------------------------------------------------
  // Preload scripts (apps/desktop/preload/). Renderers are sandboxed, and a
  // sandboxed preload is one CommonJS file that requires only `electron`.
  // ---------------------------------------------------------------------------
  preload: {
    build: {
      target: targets.node,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "apps/desktop/preload/index.ts"),
          "browser-preload": resolve(__dirname, "apps/desktop/preload/browser-preload.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
      outDir: "out/preload",
    },
  },

  // ---------------------------------------------------------------------------
  // Renderer (apps/web/) — React app
  // ---------------------------------------------------------------------------
  renderer: {
    root: resolve(__dirname, "apps/web"),
    plugins: [
      react(),
      svgr(),
      tailwindcss(),
      backendPortPlugin(),
      // electron-vite's build preset sets "./". app://deus serves assets from its root on every route.
      { name: "deus-renderer-origin", apply: "build", config: () => ({ base: "/" }) },
    ],
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
      target: targets.chrome,
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
