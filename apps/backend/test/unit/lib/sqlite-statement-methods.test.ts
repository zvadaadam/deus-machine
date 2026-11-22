import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("uses only portable SQLite statement methods in backend source", () => {
  const backend = fileURLToPath(new URL("../../../", import.meta.url));
  const src = path.join(backend, "src");
  const methods = new Set(["pluck", "raw", "expand", "iterate", "columns", "safeIntegers", "bind"]);
  // Look for property references too: a statement method can be saved and called later.
  const possible = new RegExp(`\\b(?:${[...methods].join("|")})\\b`);
  const files = ts.sys.readDirectory(src, [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
  ]);
  const bad: string[] = [];
  const config = ts.readConfigFile(path.join(backend, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, backend);
  // Resolve the backend and its SQLite types without loading every third-party package.
  const sqlite = ts.resolveModuleName(
    "better-sqlite3",
    path.join(src, "lib/sqlite.ts"),
    options,
    ts.sys
  ).resolvedModule!;
  const program = ts.createProgram([...files, sqlite.resolvedFileName], {
    ...options,
    noResolve: true,
    types: [],
    allowJs: true,
  });
  const checker = program.getTypeChecker();
  for (const name of files) {
    const file = program.getSourceFile(name)!;
    if (!possible.test(file.text)) continue;
    function visit(node: ts.Node): void {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && methods.has(node.text)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        if (
          declaration &&
          ts.isInterfaceDeclaration(declaration.parent) &&
          declaration.parent.name.text === "Statement" &&
          declaration.getSourceFile().fileName.includes("/@types/better-sqlite3/")
        ) {
          bad.push(
            `${path.relative(backend, name)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} .${node.text}()`
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(bad).toEqual([]);
});
