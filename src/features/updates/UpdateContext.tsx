/**
 * Shares auto-update state from AppContent to child components (e.g. Settings).
 * Avoids calling useAutoUpdate() twice (which would create duplicate polling).
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { UseAutoUpdateReturn } from "./hooks/useAutoUpdate";

const UpdateContext = createContext<UseAutoUpdateReturn | null>(null);

export function UpdateProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: UseAutoUpdateReturn;
}) {
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdateContext(): UseAutoUpdateReturn | null {
  return useContext(UpdateContext);
}
