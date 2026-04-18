import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/frontend",
  publicDir: "public",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/frontend",
    emptyOutDir: true,
    sourcemap: true,
  },
});
