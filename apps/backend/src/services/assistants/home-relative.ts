import { homedir } from "node:os";
import path from "node:path";

/** A diagnostic abbreviates folders under home and leaves a bare mention of home as written. */
export function homeRelative(text: string, kind: "path" | "diagnostic" = "path"): string {
  const home = homedir();
  if (kind === "diagnostic") return text.replaceAll(home + path.sep, "~" + path.sep);
  if (!path.isAbsolute(text)) return text;
  const relative = path.relative(home, text);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    return text;
  return path.join("~", relative);
}
