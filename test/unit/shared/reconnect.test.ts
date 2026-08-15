/**
 * The reconnect trigger.
 *
 * `useMessages` hangs the transcript's catch-up refetch off this listener, and
 * that refetch is the ONLY way two durable changes written while the socket
 * was down ever reach the cache: a turn.ended's accounting (an UPDATE, and the
 * messages delta carries INSERTs with `seq` greater than a cursor that jumps
 * to MAX(seq) on re-subscribe) and compaction rows (a separate table, shipped
 * only with the full page). So "did the first re-connect fire?" is not a
 * detail of the hook — it is whether tokens, cost, stop reason and compaction
 * dividers come back at all before the next reload.
 */
import { describe, expect, it, vi } from "vitest";

import { reconnectListener } from "../../../apps/web/src/shared/lib/reconnect";

describe("reconnectListener", () => {
  it("fires on the FIRST re-connect when subscribed to an already-open socket", () => {
    // The common case, and the one that used to be missed: the app's socket
    // came up long before this chat panel mounted, so the listener never saw
    // the connect that preceded it.
    const onReconnect = vi.fn();
    const listener = reconnectListener(true, onReconnect);

    listener(false);
    listener(true);

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("does not fire on the connect that follows a subscribe to a DOWN socket", () => {
    // Nothing was missed — there is no gap behind the first connect, and the
    // subscriber's own initial load is already in flight.
    const onReconnect = vi.fn();
    const listener = reconnectListener(false, onReconnect);

    listener(true);

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("fires on every re-connect after that one", () => {
    const onReconnect = vi.fn();
    const listener = reconnectListener(false, onReconnect);

    listener(true);
    listener(false);
    listener(true);
    listener(false);
    listener(true);

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("fires on a repeat connect with no disconnect in between", () => {
    // Relay mode: the browser's own socket stays up while the DESKTOP server
    // reconnects behind it and re-subscribes with fresh cursors. Same gap,
    // same loss, so the same recovery has to run.
    const onReconnect = vi.fn();
    const listener = reconnectListener(true, onReconnect);

    listener(true);

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("never fires on a disconnect", () => {
    const onReconnect = vi.fn();
    const listener = reconnectListener(true, onReconnect);

    listener(false);
    listener(false);

    expect(onReconnect).not.toHaveBeenCalled();
  });
});
