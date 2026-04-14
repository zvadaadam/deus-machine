/**
 * Shared error extraction utilities.
 *
 * Used across frontend, backend, and agent-server to safely extract information
 * from `catch (err: unknown)` blocks without `any` casts.
 */

/**
 * Safely extract an error message from any thrown value.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export type ExecErrorLike = Error & {
  killed?: boolean;
  code?: string | number | null;
  stderr?: string;
  stdout?: string;
  status?: number | null;
};

/**
 * Type guard for child_process exec/execFile errors.
 *
 * Node exposes slightly different shapes for async (`execFile`) vs sync
 * (`execFileSync`) failures, so the advertised properties are optional and
 * validated only when present.
 */
export function isExecError(err: unknown): err is ExecErrorLike {
  if (!(err instanceof Error)) return false;

  const record = err as unknown as Record<string, unknown>;
  const hasExecFields = ["killed", "code", "stderr", "stdout", "status"].some(
    (key) => key in record
  );
  if (!hasExecFields) return false;

  return (
    (!("killed" in record) || typeof record.killed === "boolean") &&
    (!("code" in record) ||
      typeof record.code === "string" ||
      typeof record.code === "number" ||
      record.code === null) &&
    (!("stderr" in record) || typeof record.stderr === "string") &&
    (!("stdout" in record) || typeof record.stdout === "string") &&
    (!("status" in record) || typeof record.status === "number" || record.status === null)
  );
}
