/** One-shot device enrollment. Never retry a request that may have consumed its code. */
import { fetchRelayTicket, relayProtocols, type RelayAccount } from "@/platform/ws/relay-access";

export type PairingTarget =
  /** Through the relay the account opens the socket; the computer approves the device. */
  | { kind: "relay"; baseUrl: string; serverId: string; account: RelayAccount }
  | { kind: "direct"; baseUrl: string };

export interface PairingGrant {
  token: string;
  deviceName: string;
}

const INVALID_RESPONSE = "Unexpected pairing response. Try a new connection code.";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function grant(value: unknown, deviceName: string): PairingGrant {
  const data = record(value);
  if (typeof data.token !== "string" || !data.token.trim()) throw new Error(INVALID_RESPONSE);
  const name = record(data.device).name;
  return { token: data.token, deviceName: typeof name === "string" ? name : deviceName };
}

async function directPair(
  baseUrl: string,
  code: string,
  deviceName: string,
  signal: AbortSignal
): Promise<PairingGrant> {
  const response = await fetch(`${baseUrl}/api/remote-auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
    signal,
  });
  const data: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    const error = record(data).error;
    throw new Error(typeof error === "string" ? error : "Invalid or expired connection code");
  }
  return grant(data, deviceName);
}

async function relayPair(
  target: Extract<PairingTarget, { kind: "relay" }>,
  code: string,
  deviceName: string,
  signal: AbortSignal
): Promise<PairingGrant> {
  const ticket = await fetchRelayTicket(target.account, target.serverId, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${target.baseUrl}/api/servers/${encodeURIComponent(target.serverId)}/pair`,
      relayProtocols(ticket)
    );
    let settled = false;
    const finish = (error: unknown, result?: PairingGrant) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Cleanup must not hide the original result, including during connection setup.
      }
      if (result) resolve(result);
      else reject(error);
    };
    const aborted = () => finish(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: "pair_request", code, deviceName }));
      } catch {
        finish(new Error("Unable to send the connection code. Try again."));
      }
    };
    socket.onmessage = (event) => {
      try {
        const data = record(JSON.parse(String(event.data)));
        if (data.type === "pair_success") finish(null, grant(data, deviceName));
        else if (data.type === "pair_failed") {
          finish(
            new Error(
              typeof data.message === "string" ? data.message : "Invalid or expired connection code"
            )
          );
        } else finish(new Error(INVALID_RESPONSE));
      } catch {
        finish(new Error(INVALID_RESPONSE));
      }
    };
    socket.onerror = () =>
      finish(new Error("Unable to connect. Check your internet and try again."));
    // Even a normal close must settle the attempt. A result may have been lost;
    // retrying automatically could consume a code twice or create another device.
    socket.onclose = () =>
      finish(new Error("Connection closed before pairing finished. Try a new connection code."));
  });
}

/** Both transports share cancellation and a deadline covering the entire exchange. */
export async function pairDevice(
  target: PairingTarget,
  code: string,
  deviceName: string,
  signal: AbortSignal
): Promise<PairingGrant> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const aborted = () => controller.abort(signal.reason);
  signal.addEventListener("abort", aborted, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Pairing timed out. Try a new connection code.")),
    30_000
  );
  try {
    const result = await (target.kind === "relay"
      ? relayPair(target, code, deviceName, controller.signal)
      : directPair(target.baseUrl, code, deviceName, controller.signal));
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", aborted);
  }
}
