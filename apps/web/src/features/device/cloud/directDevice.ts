import { readCloudSimulatorExecResult } from "@shared/cloud-simulator";
import type { CloudSimulatorExecResult } from "@shared/events";

/** Requests belong to one platform socket. Losing it settles every outstanding button press. */
export function deviceRequests() {
  const pending = new Map<
    string,
    {
      resolve: (result: CloudSimulatorExecResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function reject(id: string, error: Error) {
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(id);
    request.reject(error);
  }
  return {
    exec(send: (command: Record<string, unknown>) => void, data: Record<string, unknown>) {
      const requestId = crypto.randomUUID();
      return new Promise<CloudSimulatorExecResult>((resolve, refuse) => {
        const timer = setTimeout(
          () => reject(requestId, new Error("The device did not answer.")),
          60_000
        );
        pending.set(requestId, { resolve, reject: refuse, timer });
        try {
          send({ type: "simulator.exec.request", data: { ...data, requestId } });
        } catch (error) {
          reject(requestId, error instanceof Error ? error : new Error("The device disconnected."));
        }
      });
    },
    receive(frame: Record<string, unknown>) {
      if (typeof frame.requestId !== "string") return;
      const request = pending.get(frame.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(frame.requestId);
      request.resolve(readCloudSimulatorExecResult(frame));
    },
    disconnect() {
      for (const id of pending.keys()) reject(id, new Error("The device disconnected."));
    },
  };
}
