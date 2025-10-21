import { BrowserRouter, Routes, Route } from "react-router-dom";
import { MainLayout } from "./layouts/MainLayout";
import { ErrorBoundary, DashboardError } from "@/shared/components";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <QueryClientProvider>
      <ThemeProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <Routes>
              <Route
                path="/"
                element={
                  <ErrorBoundary fallback={<DashboardError />}>
                    <MainLayout />
                  </ErrorBoundary>
                }
              />
            </Routes>
          </BrowserRouter>
          <Toaster />
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
