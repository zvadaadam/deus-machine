// One invocation owns one Unix connection. Only the daemon owns runtime clients.
import { fork } from "node:child_process";
import { once } from "node:events";
import { open, mkdir, mkdtemp, readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { failure, help, parse } from "./commands.mjs";

const directory = path.resolve(import.meta.dirname, "../../../.context/remote-lab");
const socketPath = path.join(directory, "lab.sock");
async function dial(signal) {
  const socket = createConnection({ path: socketPath, signal });
  await once(socket, "connect");
  return socket;
}
async function launch(signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(path.join(directory, "run-"));
  const log = await open(path.join(run, "lab.log"), "a", 0o600);
  try {
    const child = fork(new URL("./daemon.mjs", import.meta.url), [run], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
    try {
      const [message] = await Promise.race([
        once(child, "message", { signal }),
        once(child, "exit", { signal }).then(([code]) => {
          throw new Error(
            "Lab process exited during startup (" + code + "). See " + run + "/lab.log"
          );
        }),
      ]);
      if (!message.listening) throw new Error(message.reason);
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  } finally {
    await log.close();
  }
}
async function main(argv) {
  if (argv.includes("--help")) {
    console.log(help);
    return;
  }
  const { command, timeout, args } = parse(argv);
  if (!command) throw new Error("Choose a command (see --help)");
  if (["up", "down", "status"].includes(command) && args.length)
    throw new Error(command + " takes no arguments");
  const deadline = Date.now() + timeout;
  // Give a timed-out wait time to report its final entries over the local socket.
  const signal = AbortSignal.timeout(timeout + 1000);
  let socket;
  try {
    socket = await dial(signal);
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    if (command === "status") {
      const last = await readFile(path.join(directory, "lab.json"), "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      console.log(JSON.stringify({ running: false, last: last ? JSON.parse(last) : null }));
      return;
    }
    if (command !== "up") throw new Error("Lab is not running. Run up first.");
    if (!process.env.AGNT_WORKSPACE)
      throw new Error("Set AGNT_WORKSPACE to the local AGNT checkout.");
    if (error.code === "ECONNREFUSED")
      await unlink(socketPath).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    await launch(signal);
    socket = await dial(signal);
  }
  try {
    const lines = createInterface({ input: socket });
    socket.write(JSON.stringify({ argv, deadline }) + "\n");
    let answer;
    for await (const line of lines) {
      answer = JSON.parse(line);
      console.log(line);
    }
    if (!answer || (command === "device follow" && !answer.done && !answer.reason))
      throw new Error("Lab closed before answering");
    if (answer.reason) process.exitCode = answer.exitCode;
  } finally {
    socket.destroy();
  }
}
main(process.argv.slice(2)).catch((error) => {
  const answer = failure(error);
  console.log(JSON.stringify(answer));
  process.exitCode = answer.exitCode;
});
