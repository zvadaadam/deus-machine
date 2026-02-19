import { createContext, useContext, useEffect, useState } from "react";
import { LazyMotion, domAnimation } from "framer-motion";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  actualTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Load theme from localStorage or default to 'system'
    const stored = localStorage.getItem("theme");
    // Validate stored value before casting
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
    return "system";
  });

  const [actualTheme, setActualTheme] = useState<"light" | "dark">(() => {
    // Resolve initial theme synchronously to avoid flicker
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    // For 'system' or missing, resolve synchronously
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = window.document.documentElement;

    // Determine the actual theme to apply
    let resolved: "light" | "dark";

    if (theme === "system") {
      // Check system preference
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      resolved = mediaQuery.matches ? "dark" : "light";

      // Apply initial system theme to DOM
      setActualTheme(resolved);
      root.classList.remove("light", "dark");
      root.classList.add(resolved);

      // Listen for system theme changes
      const listener = (e: MediaQueryListEvent) => {
        const newTheme = e.matches ? "dark" : "light";
        setActualTheme(newTheme);
        root.classList.remove("light", "dark");
        root.classList.add(newTheme);
      };

      mediaQuery.addEventListener("change", listener);

      // Cleanup
      return () => mediaQuery.removeEventListener("change", listener);
    } else {
      resolved = theme;
      // Apply explicit theme choice to DOM
      setActualTheme(resolved);
      root.classList.remove("light", "dark");
      root.classList.add(resolved);
    }
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    localStorage.setItem("theme", newTheme);
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, actualTheme }}>
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
