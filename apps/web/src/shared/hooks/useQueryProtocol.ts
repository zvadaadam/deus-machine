import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws/query-protocol-client";

/** The shell's runtime owns retries and endpoint identity across remounts. */
export function useQueryProtocol(): void {
  const cache = useQueryClient();
  const runtime = runtimeForQueryClient(cache) ?? getRuntimeClient();
  useEffect(() => {
    void runtime.connect().catch((error) => {
      if (import.meta.env.DEV) console.warn("[QueryProtocol] Connection unavailable:", error);
    });
  }, [runtime]);
}
