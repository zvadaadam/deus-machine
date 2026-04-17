// ANSI escape codes for terminal styling.
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const DIM = "\x1b[2m";
export const GRAY = "\x1b[90m";

export function statusIcon(status: "ok" | "warn" | "error"): string {
  switch (status) {
    case "ok":
      return `${GREEN}✓${RESET}`;
    case "warn":
      return `${YELLOW}⚠${RESET}`;
    case "error":
      return `${RED}✗${RESET}`;
  }
}
