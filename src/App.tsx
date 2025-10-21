import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Dashboard } from "./Dashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DashboardError } from "./components/error-fallbacks";
import { ThemeProvider } from "./hooks/useTheme";
import { Toaster } from "./components/ui/sonner";
import { queryClient } from "@/shared/api/queryClient";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
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
            </Routes>
          </BrowserRouter>
          <Toaster />
        </ErrorBoundary>
      </ThemeProvider>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}

export default App;
