import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { PRStatus } from "@/shared/types";
import { derivePRActionState } from "@/features/workspace/lib/prState";

it("waits only for the first enabled PR lookup, including when that read fails", async () => {
  const client = new QueryClient();
  let answer = Promise.withResolvers<PRStatus>();
  const options = { queryKey: ["prStatus"], queryFn: () => answer.promise, retry: false };
  const observer = new QueryObserver(client, { ...options, enabled: false });
  const unsubscribe = observer.subscribe(() => {});
  const state = () => derivePRActionState(observer.getCurrentResult(), undefined).type;
  try {
    const first = observer.refetch();
    expect(state()).toBe("create_pr");
    observer.setOptions({ ...options, enabled: true });
    expect(state()).toBe("checking");
    answer.reject(new Error("Read failed"));
    await first;
    expect(state()).toBe("create_pr");

    answer = Promise.withResolvers<PRStatus>();
    const next = observer.refetch();
    expect(state()).toBe("create_pr");
    answer.resolve({ has_pr: true, pr_number: 12, merge_status: "merged" });
    await next;
    const refresh = observer.refetch();
    expect(state()).toBe("merged");
    await refresh;
  } finally {
    unsubscribe();
    client.clear();
  }
});
