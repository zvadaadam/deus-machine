/**
 * Persistent VM Context for MCP Notebook
 *
 * Provides a sandboxed JavaScript execution environment where variables,
 * imports, and state persist across cell executions. Uses node:vm with
 * a long-lived Context object.
 */

import vm from "node:vm";
import { createRequire } from "node:module";
import path from "node:path";

const MAX_OUTPUT_LENGTH = 10_000;

export interface ExecutionResult {
  result: string | null;
  resultType: string;
  stdout: string[];
  stderr: string[];
  error: string | null;
  durationMs: number;
}

export interface InspectResult {
  value: string;
  type: string;
  properties?: string[];
}

export interface VariableInfo {
  name: string;
  type: string;
  preview: string;
}

// Names injected into the sandbox — excluded from listVariables()
const BUILTIN_NAMES = new Set([
  "require",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "fetch",
  "URL",
  "URLSearchParams",
  "AbortController",
  "TextEncoder",
  "TextDecoder",
  "structuredClone",
  "Buffer",
  "process",
  "console",
  "__capturedStdout",
  "__capturedStderr",
]);

function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") {
    return `[Function: ${value.name || "anonymous"}]`;
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (Array.isArray(value)) {
    try {
      const json = JSON.stringify(value, null, 2);
      return json.length > MAX_OUTPUT_LENGTH
        ? json.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated, ${json.length} chars total)`
        : json;
    } catch {
      return `[Array(${value.length})]`;
    }
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value, null, 2);
      return json.length > MAX_OUTPUT_LENGTH
        ? json.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated, ${json.length} chars total)`
        : json;
    } catch {
      const keys = Object.keys(value as Record<string, unknown>);
      return `{${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", ..." : ""}}`;
    }
  }
  const str = String(value);
  return str.length > MAX_OUTPUT_LENGTH
    ? str.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated)`
    : str;
}

function getType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Error) return value.constructor.name;
  if (value instanceof RegExp) return "RegExp";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (typeof value === "function") return "function";
  if (typeof value === "object") {
    const name = value.constructor?.name;
    return name && name !== "Object" ? name : "object";
  }
  return typeof value;
}

/** Simple heuristic: does the last non-empty line look like an expression? */
function isLastLineExpression(code: string): boolean {
  const lines = code.trim().split("\n");
  const last = lines[lines.length - 1].trim();
  if (!last) return false;

  // A bare closing brace (end of block statement) is never an expression
  if (last === "}") return false;

  const statementKeywords = [
    "import ",
    "export ",
    "const ",
    "let ",
    "var ",
    "function ",
    "class ",
    "if ",
    "if(",
    "for ",
    "for(",
    "while ",
    "while(",
    "switch ",
    "switch(",
    "try ",
    "try{",
    "throw ",
    "return ",
    "yield ",
    "break",
    "continue",
    "debugger",
    "//",
    "/*",
    "} else",
    "} catch",
    "} finally",
  ];

  for (const kw of statementKeywords) {
    if (last.startsWith(kw)) return false;
  }

  // Check for assignment (but not == or ===)
  // Match: x = ..., x += ..., etc. but not x == or x ===
  if (/^[a-zA-Z_$][\w$.]*\s*[+\-*/%&|^]?=(?!=)/.test(last)) return false;

  return true;
}

/** Check if code contains top-level await (simple heuristic) */
function containsAwait(code: string): boolean {
  // Remove string literals and comments to avoid false positives
  const stripped = code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return /\bawait\s/.test(stripped);
}

/**
 * Skip past a string literal starting at `start`, returning the index
 * after the closing quote. Handles escape sequences and template literal
 * `${...}` interpolations (with nested brace tracking).
 */
function skipString(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;

  if (quote === "`") {
    // Template literal — handle ${...} interpolations
    let tmplBraceDepth = 0;
    while (i < code.length) {
      if (tmplBraceDepth > 0) {
        if (code[i] === "{") { tmplBraceDepth++; i++; continue; }
        if (code[i] === "}") {
          tmplBraceDepth--;
          i++;
          continue;
        }
        // Skip nested strings inside interpolations
        if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
          i = skipString(code, i);
          continue;
        }
        i++;
        continue;
      }
      if (code[i] === "\\" && i + 1 < code.length) { i += 2; continue; }
      if (code[i] === "$" && code[i + 1] === "{") { tmplBraceDepth = 1; i += 2; continue; }
      if (code[i] === "`") return i + 1;
      i++;
    }
    return i;
  }

  // Single or double quote
  while (i < code.length) {
    if (code[i] === "\\" && i + 1 < code.length) { i += 2; continue; }
    if (code[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * At position `pos` in `code`, check whether a const/let/var declaration
 * starts here (the keyword must appear after a newline + optional whitespace,
 * or at the very start of the string). Returns the extracted names and the
 * index just past the matched pattern, or null if no declaration is found.
 */
function matchDeclaration(
  code: string,
  pos: number
): { names: string[]; end: number } | null {
  // The keyword must be at the start of the code or preceded by a newline
  // (with optional whitespace between the newline and the keyword).
  if (pos > 0) {
    // Walk backwards over whitespace; must hit a newline or start-of-string
    let back = pos - 1;
    while (back >= 0 && (code[back] === " " || code[back] === "\t")) back--;
    if (back >= 0 && code[back] !== "\n" && code[back] !== "\r") return null;
  }

  const sub = code.slice(pos);
  const kwMatch = sub.match(/^(const|let|var)\s+/);
  if (!kwMatch) return null;

  const afterKw = pos + kwMatch[0].length;
  const names: string[] = [];

  // Simple identifier: const x = ...
  const simpleMatch = code.slice(afterKw).match(/^(\w+)/);
  if (simpleMatch && code[afterKw] !== "{" && code[afterKw] !== "[") {
    names.push(simpleMatch[1]);
    return { names, end: afterKw + simpleMatch[0].length };
  }

  // Object destructuring: const { a, b: c } = ...
  if (code[afterKw] === "{") {
    const closeIdx = code.indexOf("}", afterKw);
    if (closeIdx === -1) return null;
    const inner = code.slice(afterKw + 1, closeIdx);
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      const alias = trimmed.includes(":")
        ? trimmed.split(":").pop()!.trim()
        : trimmed;
      const name = alias.split("=")[0].trim();
      if (name && /^\w+$/.test(name)) names.push(name);
    }
    return { names, end: closeIdx + 1 };
  }

  // Array destructuring: const [a, b] = ...
  if (code[afterKw] === "[") {
    const closeIdx = code.indexOf("]", afterKw);
    if (closeIdx === -1) return null;
    const inner = code.slice(afterKw + 1, closeIdx);
    for (const part of inner.split(",")) {
      const name = part.trim().replace(/^\.\.\./, "").split("=")[0].trim();
      if (name && /^\w+$/.test(name)) names.push(name);
    }
    return { names, end: closeIdx + 1 };
  }

  return null;
}

/**
 * Extract variable names from const/let/var declarations in source code.
 * Only extracts declarations at brace depth 0 (top-level), so variables
 * declared inside callbacks, if blocks, loops, or try/catch are excluded.
 * Handles simple identifiers, object destructuring { a, b: c }, and
 * array destructuring [a, b]. Used to hoist async IIFE-scoped variables
 * back to the vm.Context so they persist across cell executions.
 */
function extractDeclaredNames(code: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let i = 0;

  while (i < code.length) {
    const ch = code[i];

    // Skip string literals (single, double, template)
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }

    // Skip line comments
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }

    // Skip block comments
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }

    // Track brace depth
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }

    // Only match declarations at the top level (depth 0)
    if (depth === 0) {
      const match = matchDeclaration(code, i);
      if (match) {
        names.push(...match.names);
        i = match.end;
        continue;
      }
    }

    i++;
  }

  return [...new Set(names)];
}

export class PersistentVMContext {
  private context: vm.Context;
  private cwd: string;
  private executionCount = 0;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
    this.context = this.createFreshContext();
  }

  private createFreshContext(): vm.Context {
    const sandboxRequire = createRequire(path.resolve(this.cwd, "__notebook__.js"));

    const sandbox: Record<string, unknown> = {
      require: sandboxRequire,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      setImmediate,
      clearImmediate,
      fetch: globalThis.fetch,
      URL,
      URLSearchParams,
      AbortController,
      TextEncoder,
      TextDecoder,
      structuredClone,
      Buffer,
      process: {
        env: { ...process.env },
        cwd: () => this.cwd,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      // Placeholder — replaced per execution for capture
      console: globalThis.console,
      __capturedStdout: [] as string[],
      __capturedStderr: [] as string[],
    };

    return vm.createContext(sandbox);
  }

  async execute(
    code: string,
    options?: { timeout?: number; filename?: string }
  ): Promise<ExecutionResult> {
    const timeout = options?.timeout ?? 30_000;
    const filename = options?.filename ?? `cell_${this.executionCount + 1}`;

    const stdout: string[] = [];
    const stderr: string[] = [];

    // Inject console capture
    this.context.__capturedStdout = stdout;
    this.context.__capturedStderr = stderr;
    this.context.console = {
      log: (...args: unknown[]) => stdout.push(args.map(serializeValue).join(" ")),
      info: (...args: unknown[]) => stdout.push(args.map(serializeValue).join(" ")),
      warn: (...args: unknown[]) => stderr.push(args.map(serializeValue).join(" ")),
      error: (...args: unknown[]) => stderr.push(args.map(serializeValue).join(" ")),
      dir: (obj: unknown) => stdout.push(serializeValue(obj)),
      table: (data: unknown) => stdout.push(serializeValue(data)),
      time: () => {},
      timeEnd: () => {},
      timeLog: () => {},
      trace: (...args: unknown[]) => stderr.push(["Trace:", ...args.map(serializeValue)].join(" ")),
      assert: (condition: unknown, ...args: unknown[]) => {
        if (!condition) stderr.push(["Assertion failed:", ...args.map(serializeValue)].join(" "));
      },
      clear: () => {},
      count: () => {},
      countReset: () => {},
      group: () => {},
      groupCollapsed: () => {},
      groupEnd: () => {},
    };

    const start = performance.now();
    this.executionCount++;

    try {
      let result: unknown;
      const isAsync = containsAwait(code);
      const hasExpression = isLastLineExpression(code);

      if (isAsync) {
        // Wrap in async IIFE for top-level await.
        // Arrow functions inherit `this` from the enclosing scope, and in
        // vm.runInContext the top-level `this` is the context object. We
        // inject Object.assign(this, {...}) at the end of the IIFE body so
        // that const/let/var declarations (which are function-scoped inside
        // the IIFE) get hoisted back to the persistent context.
        const declaredNames = extractDeclaredNames(code);
        const hoistSuffix =
          declaredNames.length > 0
            ? `\n;Object.assign(this, {${declaredNames.join(",")}});`
            : "";

        let wrappedCode: string;
        if (hasExpression) {
          const lines = code.trim().split("\n");
          const lastLine = lines.pop()!;
          const body = lines.join("\n");
          wrappedCode = `(async () => { ${body}${hoistSuffix}\n  return (${lastLine}); })()`;
        } else {
          wrappedCode = `(async () => { ${code}${hoistSuffix} })()`;
        }

        const script = new vm.Script(wrappedCode, { filename });
        result = await script.runInContext(this.context, { timeout });
      } else if (hasExpression) {
        // Execute all lines, then eval last line for return value
        const lines = code.trim().split("\n");
        const lastLine = lines.pop()!;
        const body = lines.join("\n");

        if (body.trim()) {
          const bodyScript = new vm.Script(body, { filename: `${filename}_body` });
          bodyScript.runInContext(this.context, { timeout });
        }

        try {
          const exprScript = new vm.Script(`(${lastLine})`, { filename: `${filename}_expr` });
          result = exprScript.runInContext(this.context, { timeout: 5000 });
        } catch {
          // If eval fails, run as statement instead
          const stmtScript = new vm.Script(lastLine, { filename });
          stmtScript.runInContext(this.context, { timeout });
          result = undefined;
        }
      } else {
        const script = new vm.Script(code, { filename });
        result = script.runInContext(this.context, { timeout });
      }

      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      return {
        result: result !== undefined ? serializeValue(result) : null,
        resultType: getType(result),
        stdout,
        stderr,
        error: null,
        durationMs,
      };
    } catch (err) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const error = err instanceof Error ? err : new Error(String(err));
      const stack = error.stack ?? `${error.name}: ${error.message}`;

      return {
        result: null,
        resultType: "error",
        stdout,
        stderr,
        error: stack,
        durationMs,
      };
    }
  }

  async inspect(expression: string): Promise<InspectResult> {
    try {
      const script = new vm.Script(`(${expression})`, { filename: "__inspect__" });
      const value = script.runInContext(this.context, { timeout: 5000 });

      const result: InspectResult = {
        value: serializeValue(value),
        type: getType(value),
      };

      if (value !== null && value !== undefined && typeof value === "object") {
        result.properties = Object.getOwnPropertyNames(value).slice(0, 50);
      } else if (typeof value === "function") {
        result.properties = [`length: ${value.length}`, `name: ${value.name}`];
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { value: error.message, type: "error" };
    }
  }

  listVariables(): VariableInfo[] {
    return Object.getOwnPropertyNames(this.context)
      .filter((name) => !BUILTIN_NAMES.has(name))
      .map((name) => {
        const value = this.context[name];
        return {
          name,
          type: getType(value),
          preview: serializeValue(value).slice(0, 100),
        };
      });
  }

  /** Clear require cache for a module so it can be re-loaded after edits */
  clearModuleCache(modulePath: string): void {
    const resolved = (this.context.require as NodeRequire).resolve(modulePath);
    delete (this.context.require as NodeRequire).cache[resolved];
  }

  reset(): void {
    this.context = this.createFreshContext();
    this.executionCount = 0;
  }

  get currentExecutionCount(): number {
    return this.executionCount;
  }
}
