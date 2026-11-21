import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  preference?: Theme;
  setTheme: (theme: Theme) => void;
  actualTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function storedTheme(): Theme | undefined {
  const value = localStorage.getItem("theme");
  return value === "light" || value === "dark" || value === "system" ? value : undefined;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setThemeState] = useState(storedTheme);
  const theme = preference ?? "system";

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === "theme" || event.key === null)) {
        setThemeState(storedTheme());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const [actualTheme, setActualTheme] = useState<"light" | "dark">(() => {
    // Resolve initial theme synchronously to avoid flicker
    if (theme !== "system") return theme;
    // For 'system' or missing, resolve synchronously
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = window.document.documentElement;

    // Determine the actual theme to apply
    let resolved: "light" | "dark";

    // Suppress color transitions during theme switch to prevent flash
    const applyThemeClass = (newTheme: "light" | "dark") => {
      root.setAttribute("data-theme-switching", "");
      root.classList.remove("light", "dark");
      root.classList.add(newTheme);
      // Re-enable transitions after paint settles (double-rAF)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          root.removeAttribute("data-theme-switching");
        });
      });
    };

    if (theme === "system") {
      // Check system preference
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      resolved = mediaQuery.matches ? "dark" : "light";

      // Apply initial system theme to DOM
      setActualTheme(resolved);
      applyThemeClass(resolved);

      // Listen for system theme changes
      const listener = (e: MediaQueryListEvent) => {
        const newTheme = e.matches ? "dark" : "light";
        setActualTheme(newTheme);
        applyThemeClass(newTheme);
      };

      mediaQuery.addEventListener("change", listener);

      // Cleanup
      return () => mediaQuery.removeEventListener("change", listener);
    } else {
      resolved = theme;
      // Apply explicit theme choice to DOM
      setActualTheme(resolved);
      applyThemeClass(resolved);
      return undefined;
    }
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    localStorage.setItem("theme", newTheme);
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, preference, setTheme, actualTheme }}>
      {children}
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
