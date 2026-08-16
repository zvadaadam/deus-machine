/**
 * "The connection came BACK" — the listener that tells a re-connect apart from
 * the first one.
 *
 * A reconnect is not the same event as a connect: everything the socket would
 * have pushed during the gap is gone, so the subscriber has to re-read state
 * rather than wait for it. The FIRST connect needs no such recovery — there
 * was no gap behind it, and the subscriber's own initial load is already in
 * flight.
 *
 * Which makes the seed the whole point. A listener registered against a socket
 * that is ALREADY open has to count that open socket as its first connect;
 * starting from `false` instead makes the next notification — a genuine
 * re-connect, with a gap behind it — look like the first one and skip the
 * recovery it exists to run. That is not an edge case: any subscriber mounted
 * after the app's socket came up (a chat panel opened minutes in, a tab
 * switch) is in exactly that state.
 *
 * Repeat `true` without an intervening `false` fires too, deliberately: in
 * relay mode the browser's own socket stays up while the DESKTOP server
 * reconnects behind it (`server_connected`), and that gap loses the same
 * pushes.
 *
 * Split out from the hook that uses it so the rule can be tested by driving it
 * — no React, no DOM, no socket.
 */
export function reconnectListener(
  connectedAtSubscribe: boolean,
  onReconnect: () => void
): (connected: boolean) => void {
  let seenConnected = connectedAtSubscribe;
  return (connected) => {
    if (!connected) return;
    if (seenConnected) onReconnect();
    seenConnected = true;
  };
}
