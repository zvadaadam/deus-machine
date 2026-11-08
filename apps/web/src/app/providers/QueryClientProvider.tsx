import { type ReactNode, useSyncExternalStore } from "react";
import { QueryClientProvider as TanStackProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { getRuntimeClient, onRuntimeChange } from "@/platform/ws/query-protocol-client";

interface QueryClientProviderProps {
  children: ReactNode;
}

export function QueryClientProvider({ children }: QueryClientProviderProps) {
  const runtime = useSyncExternalStore(onRuntimeChange, getRuntimeClient, getRuntimeClient);
  return (
    <TanStackProvider key={runtime.identity.grant} client={runtime.queryClient}>
      {children}
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </TanStackProvider>
  );
}
