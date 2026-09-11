import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useLoadOlderMessages } from "@/features/session/api/session.queries";
import { SessionService, type PaginatedMessages } from "@/features/session/api/session.service";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Message, SessionTurn } from "@shared/types/session";

function message(id: string, seq: number): Message {
  return { id, seq, session_id: "session", role: "assistant", turn_id: "boundary" };
}

describe("turn accounting while loading older messages", () => {
  it.each([false, true])(
    "preserves freshness with a concurrent live update: %s",
    async (liveUpdate) => {
      const client = new QueryClient();
      const key = queryKeys.sessions.messages("session");
      const initial: PaginatedMessages = {
        messages: [message("latest", 3)],
        turns: [{ turnId: "boundary", startedAt: 1000 }],
        compactions: [],
        has_older: true,
        has_newer: false,
      };
      client.setQueryData(key, initial);
      const fetched: SessionTurn = {
        turnId: "boundary",
        startedAt: 1000,
        endedAt: 2000,
        cost: 0.1,
      };
      const live: SessionTurn = { ...fetched, endedAt: 3000, cost: 0.2 };
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<PaginatedMessages>();
      const fetch = vi.spyOn(SessionService, "fetchMessages").mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      let load!: ReturnType<typeof useLoadOlderMessages>["mutateAsync"];
      function Probe() {
        load = useLoadOlderMessages().mutateAsync;
        return null;
      }
      try {
        renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
        const pending = load({ sessionId: "session", beforeSeq: 3 });
        await started.promise;
        if (liveUpdate) client.setQueryData(key, { ...initial, turns: [live] });
        response.resolve({
          ...initial,
          messages: [message("older", 2), message("latest", 3)],
          turns: [fetched],
          has_older: false,
        });
        await pending;
        const result = client.getQueryData<PaginatedMessages>(key)!;
        expect(result.turns).toEqual([liveUpdate ? live : fetched]);
        expect(result.messages.map((row) => row.id)).toEqual(["older", "latest"]);
        expect(result.has_older).toBe(false);
      } finally {
        fetch.mockRestore();
        client.clear();
      }
    }
  );
});
