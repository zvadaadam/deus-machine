import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../apps/web/src/**/*.stories.@(js|jsx|ts|tsx)"],
  addons: [],
  framework: "@storybook/react-vite",
  viteFinal: async (config) => {
    return mergeConfig(config, {
      plugins: [tailwindcss()],
      build: {
        chunkSizeWarningLimit: 2000,
      },
      resolve: {
        alias: {
          "@": resolve(__dirname, "../apps/web/src"),
          "@/app": resolve(__dirname, "../apps/web/src/app"),
          "@/features": resolve(__dirname, "../apps/web/src/features"),
          "@/platform": resolve(__dirname, "../apps/web/src/platform"),
          "@/shared": resolve(__dirname, "../apps/web/src/shared"),
          "@/components": resolve(__dirname, "../apps/web/src/components"),
          "@/lib": resolve(__dirname, "../apps/web/src/shared/lib"),
          "@/hooks": resolve(__dirname, "../apps/web/src/shared/hooks"),
          "@/ui": resolve(__dirname, "../apps/web/src/components/ui"),
          "@shared": resolve(__dirname, "../shared"),
        },
      },
    });
  },
};

export default config;
