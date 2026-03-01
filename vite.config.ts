import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    svgr(),
    tailwindcss(),
    // Upload source maps to Sentry during production builds (requires SENTRY_AUTH_TOKEN)
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: "deus-40",
            project: "deus-desktop-frontend",
            authToken: process.env.SENTRY_AUTH_TOKEN,
          }),
        ]
      : []),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    chunkSizeWarningLimit: 2000,
    sourcemap: "hidden",
  },

  // Path aliases - FSD-Lite Architecture
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/app": path.resolve(__dirname, "./src/app"),
      "@/features": path.resolve(__dirname, "./src/features"),
      "@/platform": path.resolve(__dirname, "./src/platform"),
      "@/shared": path.resolve(__dirname, "./src/shared"),
      "@/components": path.resolve(__dirname, "./src/components"),
      "@/lib": path.resolve(__dirname, "./src/shared/lib"),
      "@/hooks": path.resolve(__dirname, "./src/shared/hooks"),
      "@/ui": path.resolve(__dirname, "./src/components/ui"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    // Auto-increment to next available port if 1420 is taken (like Next.js)
    // This allows running multiple dev instances simultaneously
    watch: {
      // Ignore generated/native/local workspace trees that cause noisy reload storms.
      ignored: ["**/src-tauri/**", "**/.opendevs/**"],
    },
  },
}));
