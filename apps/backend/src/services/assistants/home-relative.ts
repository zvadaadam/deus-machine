import { homedir } from "node:os";
import path from "node:path";

/** Use ~ for the home folder in paths and git diagnostics. */
export function homeRelative(text: string, kind: "path" | "diagnostic" = "path"): string {
  const home = homedir();
  if (kind === "diagnostic")
    return text.replaceAll(home, (match, at: number) => {
      const before = text[at - 1];
      if (before && !/[\s'"(:=]/.test(before)) return match;
      const rest = text.slice(at + match.length);
      if (!rest || rest.startsWith(path.sep)) return "~";
      const exact =
        before === "'" || before === '"'
          ? rest.startsWith(before)
          : /^(?:[\s)]|[.,:;](?:\s|$))/.test(rest);
      return exact ? "~" : match;
    });
  if (!path.isAbsolute(text)) return text;
  const relative = path.relative(home, text);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    return text;
  return path.join("~", relative);
}
