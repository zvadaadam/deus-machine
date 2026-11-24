import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// This trips on ordinary direct git spawns in shipping code, skipping scripts/ folders.
// A program name held in a constant, Bun's object form or shell template, and `env git`
// are outside the check.
const root = path.resolve(__dirname, "../../../../..");
const owner = "shared/lib/git-process.ts";
const runners = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execFileAsync",
  "spawn",
  "spawnSync",
]);
const gitCommand = /^\s*(?:[^\s;&|]*[/\\])?git(?:\s|$)/;

function gitSpawns(file: string, source: string): string[] {
  if (!source.includes("git")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const aliases = new Map<string, string>();
  const calls: ts.CallExpression[] = [];

  function alias(local: string, target: string) {
    if (target === "promisify" || runners.has(target)) aliases.set(local, target);
  }
  function name(expression: ts.Expression): string {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (
      ts.isCallExpression(expression) &&
      name(expression.expression) === "promisify" &&
      expression.arguments[0]
    )
      return name(expression.arguments[0]);
    return "";
  }
  function literal(expression: ts.Expression | undefined): string {
    if (!expression) return "";
    if (ts.isTemplateExpression(expression)) return expression.head.text;
    return ts.isStringLiteralLike(expression) ? expression.text : "";
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      ts.isIdentifier(node.name)
    )
      alias(node.name.text, name(node.propertyName));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      alias(node.name.text, name(node.initializer));
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return calls
    .filter((call) => {
      const runner = name(call.expression);
      if (!runners.has(runner)) return false;
      const [program, args] = call.arguments;
      if (
        program &&
        ts.isCallExpression(program) &&
        name(program.expression) === "resolveCliExecutable"
      ) {
        const [tool] = program.arguments;
        return tool && ts.isStringLiteralLike(tool) && tool.text === "git";
      }
      const command = literal(
        program && ts.isArrayLiteralExpression(program) ? program.elements[0] : program
      );
      if (gitCommand.test(command)) return true;
      if (runner !== "exec" && runner !== "execSync" && path.win32.basename(command) === "git")
        return true;
      if (
        !/^(?:.*\/)?(?:sh|bash|zsh)$/.test(command) ||
        !args ||
        !ts.isArrayLiteralExpression(args)
      )
        return false;
      const commandFlag = args.elements.findIndex((arg) => /^-[a-z]*c$/.test(literal(arg)));
      return commandFlag !== -1 && gitCommand.test(literal(args.elements[commandFlag + 1]));
    })
    .map((call) => `${file}:${tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1}`);
}

it("reports the file and line of a direct git call, including aliases and shell commands", () => {
  const fixture = [
    'execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root });',
    "const launch = util.promisify(cp.execFile);",
    "launch(",
    '  "git", args);',
    "exec(`git status ${file}`);",
    'spawn("/bin/sh", ["-ec", "git diff"]);',
    'spawn("gh", ["api", "git"]);',
    '// exec("git log");',
    'import { promisify as wrap } from "node:util";',
    'const { execFile: execute } = require("node:child_process");',
    'wrap(execute)("git", ["status"]);',
    'Bun.spawnSync(["git", "version"]);',
    'execFile("/usr/bin/git", ["status"]);',
    'execFileAsync(resolveCliExecutable("git"), ["status"]);',
  ].join("\n");
  expect(gitSpawns("old.ts", fixture)).toEqual([
    "old.ts:1",
    "old.ts:3",
    "old.ts:5",
    "old.ts:6",
    "old.ts:11",
    "old.ts:12",
    "old.ts:13",
    "old.ts:14",
  ]);
});

it("keeps git process creation in the shared runner", () => {
  const skippedDirs = ["node_modules", "scripts", "test", "tests", "__tests__", "dist", "build"];
  const cliBundles = path.join("apps", "cli", "bundles");
  // Node matches wildcard filenames case-insensitively on macOS and Windows.
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  const files = globSync("{apps,shared,packages}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
    cwd: root,
    exclude: (entry) => entry === cliBundles || skippedDirs.includes(path.basename(entry)),
  })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => !/\.(test|spec)\./.test(foldCase ? file.toLowerCase() : file));
  expect(files).toContain("apps/backend/src/api/repos.ts");
  const violations = files
    .filter((file) => file !== owner)
    .flatMap((file) => gitSpawns(file, readFileSync(path.join(root, file), "utf8")));
  expect(violations.sort(), `Use runGit in ${owner}`).toEqual([]);
});
