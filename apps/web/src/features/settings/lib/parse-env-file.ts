export interface EnvFileEntry {
  name: string;
  value: string;
}

/** Parse dotenv data, never shell code. Expansions such as ${NAME} stay literal. */
export function parseEnvFile(source: string): EnvFileEntry[] {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const entries = new Map<string, string>();
  let offset = 0;
  const invalid = () =>
    new Error(
      `Invalid environment file at line ${text.slice(0, offset).split("\n").length}. Expected NAME=value.`
    );
  while (offset < text.length) {
    const spacing = text.slice(offset).match(/^\s*/)!;
    offset += spacing[0].length;
    if (offset === text.length) break;
    if (text[offset] === "#") {
      const end = text.indexOf("\n", offset);
      offset = end < 0 ? text.length : end + 1;
      continue;
    }
    const assignment = text
      .slice(offset)
      .match(/^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/);
    if (!assignment) throw invalid();
    const name = assignment[1];
    offset += assignment[0].length;
    let value: string;
    const quote = text[offset];
    if (quote === '"' || quote === "'" || quote === "`") {
      const start = ++offset;
      while (offset < text.length && text[offset] !== quote) {
        if (text[offset] === "\\" && (text[offset + 1] === quote || text[offset + 1] === "\\"))
          offset++;
        offset++;
      }
      if (offset === text.length) throw invalid();
      value = text.slice(start, offset++);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      const suffix = text.slice(offset).match(/^[ \t]*(?:#[^\n]*)?(?:\n|$)/);
      if (!suffix) throw invalid();
      offset += suffix[0].length;
    } else {
      const end = text.indexOf("\n", offset);
      value = text
        .slice(offset, end < 0 ? text.length : end)
        .split("#", 1)[0]
        .trim();
      offset = end < 0 ? text.length : end + 1;
    }
    if (name.length > 128 || value.length > 10000)
      throw new Error(
        "Environment names must be at most 128 characters and values at most 10,000 characters."
      );
    if (entries.has(name))
      throw new Error(`${name} appears more than once. Keep one value before importing.`);
    entries.set(name, value);
    if (entries.size > 100) throw new Error("Import up to 100 variables at a time.");
  }
  if (!entries.size) throw new Error("No environment variables found. Expected NAME=value.");
  return Array.from(entries, ([name, value]) => ({ name, value }));
}
