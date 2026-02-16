import { useEffect } from "react";
import { useTheme } from "../src/app/providers/ThemeProvider";

/**
 * Syncs the Storybook toolbar theme toggle with the ThemeProvider context.
 * Without this, components that read `useTheme().actualTheme` (e.g. Shiki
 * code blocks) would get the wrong theme when the toolbar is toggled.
 */
export function ThemeSync({ theme }: { theme: "light" | "dark" }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);
  return null;
}
