import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(js|jsx|ts|tsx)"],
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
          "@": resolve(__dirname, "../src"),
          "@/app": resolve(__dirname, "../src/app"),
          "@/features": resolve(__dirname, "../src/features"),
          "@/platform": resolve(__dirname, "../src/platform"),
          "@/shared": resolve(__dirname, "../src/shared"),
          "@/components": resolve(__dirname, "../src/components"),
          "@/lib": resolve(__dirname, "../src/shared/lib"),
          "@/hooks": resolve(__dirname, "../src/shared/hooks"),
          "@/ui": resolve(__dirname, "../src/components/ui"),
        },
      },
    });
  },
};

export default config;
