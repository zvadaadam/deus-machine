// shared/integrations/command-line.ts
// A local server is typed as one line ("node "/Users/me/My Tools/server.js"")
// and run as a program with arguments, never through a shell.

/**
 * Split a command line into its program and arguments, reading quotes the
 * way a shell does without running one: spaces separate; single quotes keep
 * everything; double quotes keep spaces and take `\"` and `\\`; outside
 * quotes a backslash keeps a following space, quote or backslash (any other
 * backslash is itself, so a Windows path survives). Null when a quote is
 * left open.
 */
export function splitCommandLine(line: string): string[] | null {
  const words: string[] = [];
  let word = "";
  // A quoted empty string is an argument too, so "has a word begun" is its own fact.
  let begun = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    const next = line[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && (next === '"' || next === "\\")) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      begun = true;
    } else if (char === "\\" && next !== undefined && /[\s'"\\]/.test(next)) {
      word += line[++i];
      begun = true;
    } else if (/\s/.test(char)) {
      if (begun) words.push(word);
      word = "";
      begun = false;
    } else {
      word += char;
      begun = true;
    }
  }
  if (quote) return null;
  if (begun) words.push(word);
  return words;
}
