/**
 * SettingsRoute -- thin route wrapper for the settings page.
 *
 * Opens the settings view in the UI store on mount and closes it on unmount.
 * MainLayout reads settingsOpen from the store and renders the SettingsPage.
 * This keeps MainLayout router-agnostic.
 */

import { useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { DashboardError } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { MainLayout } from "../layouts/MainLayout";
import { useUIStore } from "@/shared/stores/uiStore";

export function SettingsRoute() {
  const openSettings = useUIStore((s) => s.openSettings);
  const closeSettings = useUIStore((s) => s.closeSettings);

  // Sync route -> UI store: open settings on mount, close on unmount
  useEffect(() => {
    openSettings();
    return () => {
      closeSettings();
    };
  }, [openSettings, closeSettings]);

  return (
    <ErrorBoundary
      FallbackComponent={DashboardError}
      onError={createBoundaryErrorHandler("react.error-boundary.settings")}
    >
      <MainLayout />
    </ErrorBoundary>
  );
}
