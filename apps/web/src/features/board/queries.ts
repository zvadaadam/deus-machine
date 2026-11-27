import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { InputOf } from "@shared/api/op";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

/** A seen mark belongs to the same host and account as this board read. */
export function useBoardSeenScope() {
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  return JSON.stringify([runtime.identity.host, runtime.identity.account]) + ":";
}

export function useBoards() {
  const queryKey = [api.boards.name];
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  useQuerySubscription(api.boards, { queryKey });
  return useQuery({ queryKey, queryFn: () => runtime.call(api.boards), staleTime: Infinity });
}

export function useBoardChannel(params: InputOf<typeof api.boardChannel>) {
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  const queryKey = [api.boardChannel.name, params];
  useQuerySubscription(api.boardChannel, { queryKey, params });
  return useQuery({
    queryKey,
    queryFn: () => runtime.call(api.boardChannel, params),
    staleTime: Infinity,
  });
}

export function useBoardThread(params: InputOf<typeof api.boardThread>) {
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  const queryKey = [api.boardThread.name, params];
  useQuerySubscription(api.boardThread, { queryKey, params });
  return useQuery({
    queryKey,
    queryFn: () => runtime.call(api.boardThread, params),
    staleTime: Infinity,
  });
}
