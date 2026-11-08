import { QueryClient } from "@tanstack/react-query";

/** Each authenticated runtime owns a cache; queries must never cross hosts. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: false,
        networkMode: "always",
      },
      mutations: {
        // A lost response can follow a committed write. Retrying may repeat it.
        retry: false,
        networkMode: "always",
      },
    },
  });
}

/** Compatibility binding for app-wide consumers; replaced at a runtime boundary. */
export let queryClient = createQueryClient();

export function setActiveQueryClient(client: QueryClient): void {
  queryClient = client;
}
