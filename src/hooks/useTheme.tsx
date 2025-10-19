import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  actualTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Load theme from localStorage or default to 'system'
    const stored = localStorage.getItem('theme') as Theme;
    return stored || 'system';
  });

  const [actualTheme, setActualTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = window.document.documentElement;

    // Determine the actual theme to apply
    let resolved: 'light' | 'dark' = 'light';

    if (theme === 'system') {
      // Check system preference
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      resolved = mediaQuery.matches ? 'dark' : 'light';

      // Listen for system theme changes
      const listener = (e: MediaQueryListEvent) => {
        const newTheme = e.matches ? 'dark' : 'light';
        setActualTheme(newTheme);
        root.classList.remove('light', 'dark');
        root.classList.add(newTheme);
      };

      mediaQuery.addEventListener('change', listener);

      // Cleanup
      return () => mediaQuery.removeEventListener('change', listener);
    } else {
      resolved = theme;
    }

    // Apply theme
    setActualTheme(resolved);
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    localStorage.setItem('theme', newTheme);
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, actualTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
