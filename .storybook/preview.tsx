import React, { useEffect } from "react";
import type { Preview } from "@storybook/react-vite";
import { ThemeProvider } from "../src/app/providers/ThemeProvider";
import { ThemeSync } from "./theme-sync";
import "../src/global.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "dark", icon: "moon", title: "Dark" },
          { value: "light", icon: "sun", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "dark",
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals.theme || "dark") as "light" | "dark";
      useEffect(() => {
        const html = document.documentElement;
        if (theme === "dark") {
          html.classList.add("dark");
        } else {
          html.classList.remove("dark");
        }
        return () => html.classList.remove("dark");
      }, [theme]);

      return (
        <ThemeProvider>
          <ThemeSync theme={theme} />
          <div className="bg-background text-foreground min-h-screen p-4">
            <Story />
          </div>
        </ThemeProvider>
      );
    },
  ],
};

export default preview;
