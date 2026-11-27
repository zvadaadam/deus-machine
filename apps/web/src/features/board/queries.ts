import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { InputOf } from "@shared/api/op";
import { useRuntimeClient } from "@/platform/ws/useRuntimeClient";
import type { CallArgs } from "@/platform/ws/runtime-client";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

/** A seen mark belongs to the same host and account as this board read. */
export function useBoardSeenScope() {
  const { identity } = useRuntimeClient();
  return JSON.stringify([identity.host, identity.account]) + ":";
}

type BoardRead = typeof api.boards | typeof api.boardChannel | typeof api.boardThread;

function useBoardRead<O extends BoardRead>(op: O, ...args: CallArgs<O>) {
  const runtime = useRuntimeClient();
  const [params] = args;
  const queryKey = params ? [op.name, params] : [op.name];
  useQuerySubscription(op, { queryKey, params });
  return useQuery({ queryKey, queryFn: () => runtime.call(op, ...args), staleTime: Infinity });
}

export const useBoards = () => useBoardRead(api.boards);
export const useBoardChannel = (params: InputOf<typeof api.boardChannel>) =>
  useBoardRead(api.boardChannel, params);
export const useBoardThread = (params: InputOf<typeof api.boardThread>) =>
  useBoardRead(api.boardThread, params);
