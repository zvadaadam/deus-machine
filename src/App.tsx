import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import { Settings } from "./Settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DashboardError, SettingsError } from "./components/error-fallbacks";
import { ThemeProvider } from "./hooks/useTheme";
import { Toaster } from "./components/ui/sonner";

function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route
              path="/"
              element={
                <ErrorBoundary fallback={<DashboardError />}>
                  <Dashboard />
                </ErrorBoundary>
              }
            />
            <Route
              path="/settings"
              element={
                <ErrorBoundary fallback={<SettingsError />}>
                  <Settings />
                </ErrorBoundary>
              }
            />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
