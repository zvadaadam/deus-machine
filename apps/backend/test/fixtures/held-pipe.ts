import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { onTestFinished } from "vitest";

/** A child reading this FIFO stays alive until it is stopped or the test finishes. */
export function holdOpenPipe(path: string) {
  execFileSync("mkfifo", [path]);
  const writer = openSync(path, constants.O_RDWR);
  onTestFinished(() => closeSync(writer));
}
