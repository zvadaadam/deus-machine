/**
 * The desktop speaks to the backend it starts through the backend's stdin: a
 * pipe it holds, with `DEUS_STOP_ON_STDIN_END=1` set.
 *
 * - Its first line is the spawn token, the secret that alone may hand this
 *   backend account credentials (routes/settings.ts). It never travels in an
 *   environment, where every process this backend starts would inherit it and
 *   `ps eww` would show it to any process of this user.
 * - The pipe then stays open, and the backend stops when it ends. When the
 *   desktop exits (a Quit, a crash or a SIGKILL alike) the system closes its
 *   end of the pipe, stdin ends here, and the backend shuts down as it does on
 *   SIGTERM. Without this, a desktop that dies leaves its backend holding the
 *   relay tunnel and the database, and the next launch starts a second one.
 *
 * Every other way of running the backend (`bun run dev:web`, the CLI, tests)
 * leaves the variable unset, and then stdin is not touched at all: it may be a
 * terminal, or closed from the start. Such a backend has no spawn token.
 */
export const STOP_ON_STDIN_END_ENV = "DEUS_STOP_ON_STDIN_END";

let settleToken: (token: string | null) => void = () => {};
/** The spawn token: the desktop's first line, or null (not started by the desktop, or stdin ended first). */
export const spawnToken: Promise<string | null> = new Promise((resolve) => {
  settleToken = resolve;
});

export function stopWhenStdinEnds(
  stop: () => void,
  env: NodeJS.ProcessEnv = process.env,
  stdin?: NodeJS.ReadableStream
): boolean {
  if (env[STOP_ON_STDIN_END_ENV] !== "1") {
    settleToken(null);
    return false;
  }
  // Ours alone: what this backend starts (terminals, agents, a nested dev
  // backend run in one of its terminals) must not inherit it.
  delete env[STOP_ON_STDIN_END_ENV];

  const input = stdin ?? process.stdin;
  let stopped = false;
  const once = () => {
    settleToken(null);
    if (stopped) return;
    stopped = true;
    stop();
  };
  input.on("end", once);
  input.on("close", once);
  input.on("error", once);
  // Until the first line is complete; then null, and the rest is ignored.
  let firstLine: string | null = "";
  input.on("data", (chunk: Buffer | string) => {
    if (firstLine === null) return;
    firstLine += String(chunk);
    const end = firstLine.indexOf("\n");
    if (end < 0) return;
    settleToken(firstLine.slice(0, end).trim() || null);
    firstLine = null;
  });
  input.resume();
  return true;
}
