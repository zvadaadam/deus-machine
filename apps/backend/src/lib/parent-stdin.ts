/**
 * A backend started by the desktop stops when the desktop does, however it
 * ends. The desktop spawns it with stdin a pipe that it never writes to and
 * sets `DEUS_STOP_ON_STDIN_END=1`; when the desktop exits (a Quit, a crash or
 * a SIGKILL alike) the system closes its end of the pipe, stdin ends here, and
 * the backend shuts down as it does on SIGTERM. Without this, a desktop that
 * dies leaves its backend holding the relay tunnel and the database, and the
 * next launch starts a second one.
 *
 * Every other way of running the backend (`bun run dev:web`, the CLI, tests)
 * leaves the variable unset, and then stdin is not touched at all: it may be a
 * terminal, or closed from the start.
 */
export const STOP_ON_STDIN_END_ENV = "DEUS_STOP_ON_STDIN_END";

export function stopWhenStdinEnds(
  stop: () => void,
  env: NodeJS.ProcessEnv = process.env,
  stdin?: NodeJS.ReadableStream
): boolean {
  if (env[STOP_ON_STDIN_END_ENV] !== "1") return false;
  // Ours alone: what this backend starts (terminals, agents, a nested dev
  // backend run in one of its terminals) must not inherit it.
  delete env[STOP_ON_STDIN_END_ENV];

  const input = stdin ?? process.stdin;
  let stopped = false;
  const once = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  input.on("end", once);
  input.on("close", once);
  input.on("error", once);
  // The desktop writes nothing; read anyway, so the end is noticed.
  input.on("data", () => {});
  input.resume();
  return true;
}
