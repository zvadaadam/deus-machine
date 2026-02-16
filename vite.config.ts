import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), svgr(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 2000,
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
      ignored: ["**/src-tauri/**", "**/.hive/**"],
    },
  },
}));
