import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./App.css";
import { Dashboard } from "./Dashboard";
import { Settings } from "./Settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DashboardError, SettingsError } from "./components/error-fallbacks";

function App() {
  return (
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
    </ErrorBoundary>
  );
}

export default App;
