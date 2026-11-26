import { toast } from "sonner";
import type { QueryClient } from "@tanstack/react-query";
import type { AgentAuthAnswer } from "@shared/agent-auth";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { queryClient as activeClient } from "@/shared/api/queryClient";
import { getAgentLabel } from "@/shared/agents";

interface Install {
  finish(message?: string): void;
  read?: Promise<AgentAuthAnswer>;
}
const requests = new WeakMap<QueryClient, Map<string, Install>>();

export function requestAgentInstall(client: QueryClient, harness: string) {
  const pending = requests.get(client) ?? new Map<string, Install>();
  function finish(message?: string) {
    if (pending.get(harness)?.finish !== finish) return;
    pending.delete(harness);
    if (message && client === activeClient) toast.error(message, { id: `cli-install-${harness}` });
  }
  pending.set(harness, { finish });
  requests.set(client, pending);
  return finish;
}

/** Check the installs pending at reset. A retry or fresh progress supersedes this read. */
export async function reconcileAgentInstalls(client: QueryClient) {
  const pending = requests.get(client);
  if (!pending?.size) return;
  const read = call(api.agentAuth);
  for (const install of pending.values()) install.read = read;
  const answer = await read.catch(() => undefined);
  for (const cli of answer?.clis ?? []) {
    if (pending.get(cli.harness)?.read === read)
      reportInstallProgress(client, cli.harness, cli.state, cli.error);
  }
}

export function reportInstallProgress(
  client: QueryClient,
  harness: string,
  state: string,
  error?: string
) {
  const install = requests.get(client)?.get(harness);
  if (!install) return;
  delete install.read;
  if (state === "ready") install.finish();
  if (state === "failed") {
    const reason = error?.trim() || "The install failed.";
    install.finish(`Couldn’t install ${getAgentLabel(harness)}: ${reason}`);
  }
}
