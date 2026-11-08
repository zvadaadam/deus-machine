// shared/keep-awake.ts
// The backend tells the desktop's main process, on its stdout, whether a
// connected device wants the computer kept awake (Remote access → Keep this
// Mac awake). One line per change: `DEUS_KEEP_AWAKE:1` or `DEUS_KEEP_AWAKE:0`.

const KEEP_AWAKE_MARKER = "DEUS_KEEP_AWAKE:";

/** The stdout line that reports `wanted`. */
export function keepAwakeLine(wanted: boolean): string {
  return `${KEEP_AWAKE_MARKER}${wanted ? "1" : "0"}`;
}

/** What a backend stdout line reports, or null when it is not a keep-awake line. */
export function readKeepAwakeLine(line: string): boolean | null {
  return line.startsWith(KEEP_AWAKE_MARKER) ? line.slice(KEEP_AWAKE_MARKER.length) === "1" : null;
}
