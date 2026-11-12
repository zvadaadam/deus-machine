// A minimal client for a running backend's operations, for scripts that drive a
// real app from outside it. It speaks the q: wire over the backend's socket: a
// read is a q:request, a write a q:mutate. From this computer the backend
// admits the socket as its own window, so no device grant is involved.
//
//   const backend = await connectBackend("http://localhost:54321");
//   const { workspaceId } = await backend.write("createWorkspace", { repository_id });
//   const workspace = await backend.read("workspace", { workspaceId });
//   backend.close();
import { WebSocket } from "ws";

export async function connectBackend(url, { timeoutMs = 30_000 } = {}) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`);
  const waiting = new Map();
  let next = 0;

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "connected") return resolve();
      const pending = waiting.get(frame.id);
      if (!pending) return;
      waiting.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.type === "q:response") pending.resolve(frame.data);
      else if (frame.type === "q:mutate_result" && frame.success) pending.resolve(frame.data);
      else pending.reject(new Error(frame.error ?? frame.message ?? `${pending.name} failed`));
    });
  });

  function ask(frame, name) {
    const id = `script_${++next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${name} timed out`));
      }, timeoutMs);
      waiting.set(id, { name, resolve, reject, timer });
      socket.send(JSON.stringify({ ...frame, id }));
    });
  }

  return {
    read: (name, params = {}) => ask({ type: "q:request", resource: name, params }, name),
    write: (name, params = {}) => ask({ type: "q:mutate", action: name, params }, name),
    close: () => socket.close(),
  };
}
