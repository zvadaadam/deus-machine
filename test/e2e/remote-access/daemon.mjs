import { once } from "node:events";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { createLab } from "./lab.mjs";
import { failure, parse, runCommand } from "./commands.mjs";

const directory = process.argv[2],
  parent = path.dirname(directory);
const socketPath = path.join(parent, "lab.sock");
const manifest = path.join(parent, "lab.json");
const idleSeconds = 30 * 60;
const lab = createLab({
  root: path.resolve(import.meta.dirname, "../../.."),
  agnt: process.env.AGNT_WORKSPACE,
  directory,
});
let phase = "starting",
  idle,
  activeCommands = 0,
  busy,
  shutdown;
const peers = new Set();
function status() {
  const services = {};
  for (const n of ["cloud", "relay", "host"]) {
    const part = lab[n];
    if (part)
      services[n] = {
        address: part.url ?? part.ws ?? part.base,
        pid: part.child.pid,
        log: part.log.path,
      };
  }
  if (lab.pg) services.postgres = { address: lab.pg.address, container: lab.pg.container };
  if (lab.issuer) services.issuer = { address: lab.issuer.url, pid: process.pid };
  return {
    phase,
    pid: process.pid,
    directory,
    log: path.join(directory, "lab.log"),
    idleSeconds,
    services,
    devices: [...lab.devices.keys()],
  };
}
async function save() {
  await writeFile(manifest + ".tmp", JSON.stringify(status(), null, 2) + "\n", { mode: 0o600 });
  await rename(manifest + ".tmp", manifest);
}
function resetIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => void stop(), idleSeconds * 1000);
}
function stop(requester) {
  if (shutdown) return shutdown;
  phase = "stopping";
  clearTimeout(idle);
  for (const peer of peers) if (peer !== requester) peer.destroy();
  shutdown = (async () => {
    await busy?.catch(() => {});
    try {
      await lab.close();
      phase = "stopped";
    } catch (error) {
      phase = "failed";
      throw error;
    } finally {
      try {
        await save();
      } finally {
        server.close();
        for (const peer of peers) if (peer !== requester) peer.destroy();
      }
    }
  })();
  return shutdown;
}
async function dispatch(cmd, signal, emit, socket) {
  if (cmd.command === "status") return status();
  if (cmd.command === "down") {
    await stop(socket);
    return { phase: "stopped" };
  }
  if (phase === "stopping" || phase === "stopped") throw new Error("Lab is stopping");
  if (cmd.command === "up") {
    if (busy || phase === "ready") throw new Error("Lab is already up or starting");
    busy = (async () => {
      signal.throwIfAborted();
      await lab.up();
      signal.throwIfAborted();
      await lab.signIn();
      await lab.connectedAs();
      signal.throwIfAborted();
      if (!shutdown) phase = "ready";
      await save();
      signal.throwIfAborted();
    })();
    try {
      await busy;
      return status();
    } catch (error) {
      busy = undefined;
      await stop(socket);
      throw error;
    } finally {
      busy = undefined;
    }
  }
  if (phase !== "ready") throw new Error("Lab is starting");
  const run = () => runCommand(lab, cmd, signal, emit);
  if (
    !cmd.command.startsWith("fault ") &&
    !["device pair", "host revoke", "assistant add"].includes(cmd.command)
  )
    return run();
  if (busy) throw new Error("Another lab change is in progress");
  busy = run().finally(save);
  try {
    return await busy;
  } finally {
    busy = undefined;
  }
}
const server = createServer((socket) => {
  peers.add(socket);
  const gone = new AbortController();
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    peers.delete(socket);
    gone.abort();
  });
  const reader = createInterface({ input: socket });
  reader.once("line", async (line) => {
    const emit = (data) => {
      if (!socket.destroyed) socket.write(JSON.stringify(data) + "\n");
    };
    let timer, cmd;
    try {
      const { argv, deadline } = JSON.parse(line);
      cmd = parse(argv);
      const remaining = Math.min(cmd.timeout, deadline - Date.now());
      if (!Number.isFinite(remaining)) throw new Error("Invalid command deadline");
      const timeout = new AbortController();
      const expired = new DOMException("Command timed out", "TimeoutError");
      if (remaining <= 0) timeout.abort(expired);
      else timer = setTimeout(() => timeout.abort(expired), remaining);
      const signal = AbortSignal.any([timeout.signal, gone.signal]);
      if (cmd.command !== "up" && cmd.command !== "device wait") signal.throwIfAborted();
      clearTimeout(idle);
      activeCommands++;
      const operation = dispatch(cmd, signal, emit, socket).finally(() => {
        if (--activeCommands === 0 && !shutdown) resetIdle();
      });
      // A wait reports the state and entries it observed, including on timeout.
      const answer =
        cmd.command === "device wait" || cmd.command === "device follow"
          ? await operation
          : await Promise.race([
              operation,
              once(signal, "abort").then(() => {
                throw signal.reason;
              }),
            ]);
      emit(answer);
    } catch (error) {
      emit(failure(error, phase === "ready" && cmd?.command !== "up"));
    } finally {
      clearTimeout(timer);
      socket.end();
    }
  });
});
async function fatal(error) {
  console.error(error);
  try {
    await stop();
  } catch (stopError) {
    console.error(stopError);
  }
  process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
try {
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  await save();
  resetIdle();
  process.send({ listening: true });
  for (const event of ["SIGTERM", "SIGINT"]) process.once(event, () => void stop());
} catch (error) {
  process.send({
    reason: error.code === "EADDRINUSE" ? "Lab is already up or starting" : error.message,
  });
  if (server.listening) server.close();
}
