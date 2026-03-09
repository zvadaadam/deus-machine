/**
 * Shared error extraction utilities.
 *
 * Used across frontend, backend, and sidecar to safely extract information
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

/**
 * Safely extract .code from a thrown value (e.g., Node.js ENOENT, EACCES).
 */
export function getErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Type guard for child_process exec errors with .killed, .code, .stderr, .stdout.
 */
export function isExecError(err: unknown): err is Error & {
  killed: boolean;
  code: string | number | null;
  stderr: string;
  stdout: string;
  status: number | null;
} {
  return (
    err instanceof Error &&
    "killed" in err &&
    typeof (err as Record<string, unknown>).killed === "boolean"
  );
}
