/**
 * RootLayout -- outermost web route layout.
 *
 * Provides the same providers and error boundary that App.tsx wraps around
 * the desktop shell, but for the web router tree. TanStack Router's Outlet
 * renders the matched child route.
 */

import { Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return <Outlet />;
}
