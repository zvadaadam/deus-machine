import { useQueryClient } from "@tanstack/react-query";
import { getRuntimeClient, runtimeForQueryClient } from "./query-protocol-client";

/** Hold the host and account that own this component's query cache. */
export function useRuntimeClient() {
  return runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
}
