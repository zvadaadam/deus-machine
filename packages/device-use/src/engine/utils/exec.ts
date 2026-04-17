import { execFile } from "node:child_process";
import type { CommandExecutor, ExecOptions, ExecResult } from "../types.js";

const DEFAULT_TIMEOUT = 120_000;
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function createExecutor(defaults: ExecOptions = {}): CommandExecutor {
  return async (command: string[], opts?: ExecOptions): Promise<ExecResult> => {
    const [bin, ...args] = command;
    if (!bin) {
      return { success: false, output: "", error: "Empty command", exitCode: -1 };
    }

    const timeout = opts?.timeout ?? defaults.timeout ?? DEFAULT_TIMEOUT;
    const cwd = opts?.cwd ?? defaults.cwd;
    const env =
      defaults.env || opts?.env ? { ...process.env, ...defaults.env, ...opts?.env } : process.env;

    return new Promise<ExecResult>((resolve) => {
      execFile(
        bin,
        args,
        { timeout, maxBuffer: DEFAULT_MAX_BUFFER, env, cwd },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              output: stdout,
              error: stderr || error.message,
              exitCode: error.code ? Number(error.code) : (error as NodeJS.ErrnoException).errno,
            });
          } else {
            resolve({
              success: true,
              output: stdout,
              error: stderr || undefined,
              exitCode: 0,
            });
          }
        }
      );
    });
  };
}
