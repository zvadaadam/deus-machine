import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { SCHEMA_SQL } from "@shared/schema";
import { expect, it } from "vitest";

const backend = path.resolve(__dirname, "../../..");
const owner = "src/services/workspace-lifecycle.ts";
const seed = "../../scripts/dev/seed-demo-states.ts";
const unknown = "«dynamic»";
const protectedColumns = new Set([
  "state",
  "init_stage",
  "setup_status",
  "init_fetch_issue",
  "error_message",
  "error_detail",
]);

// Let SQLite parse the assignments, including tuple SETs and ON CONFLICT.
// Preparing a write to a generated column fails. A DELETE compiles the
// trigger and fails on its deliberately missing function. No statement runs.
function guardedSchema() {
  const schema = new Database(":memory:");
  schema.exec(SCHEMA_SQL);
  const columns = schema.pragma("table_info(workspaces)") as { name: string; pk: number }[];
  schema.close();
  const guard = new Database(":memory:");
  const definitions = columns.map(({ name, pk }) =>
    protectedColumns.has(name) ? `${name} AS (NULL)` : pk ? `${name} PRIMARY KEY` : name
  );
  guard.exec(`CREATE TABLE workspaces (${definitions.join(", ")})`);
  guard.exec(SCHEMA_SQL);
  guard.pragma("recursive_triggers = ON"); // REPLACE also deletes its conflicting row.
  guard.exec(
    "CREATE TRIGGER fence_delete BEFORE DELETE ON workspaces BEGIN SELECT forbidden_workspace_delete(); END"
  );
  return guard;
}

function writesLifecycle(sql: string, db: Database.Database) {
  // Keep quoted values and identifiers intact while splitting exec() batches.
  const pieces =
    sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|;|[^;'"`[/-]+|./gs
    ) ?? [];
  let statement = "";
  for (const piece of [...pieces, ";"]) {
    if (piece !== ";") {
      statement += /^(?:--|\/\*)/.test(piece) ? " " : piece;
      continue;
    }
    const raw = statement.trim();
    statement = "";
    // An unresolved head or a write target that could resolve to workspaces
    // cannot establish ownership. Other tables may build their own SQL.
    if (raw.split(/\s+/, 1)[0].includes(unknown)) return true;
    const target =
      /\b(?:update(?:\s+or\s+\w+)?|(?:insert(?:\s+or\s+\w+)?|replace)\s+into|delete\s+from)\b\s*(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?([\w«»]*)/gi;
    const targets = [...raw.matchAll(target)].map((match) => match[1].toLowerCase());
    if (targets.some((t) => t.includes(unknown) && "workspaces".startsWith(t.split(unknown)[0])))
      return true;
    if (!targets.includes("workspaces")) continue;
    try {
      db.prepare(`EXPLAIN ${raw.replaceAll(unknown, "?")}`);
    } catch {
      // Also fails closed for a write with opaque column names or SQL shape.
      return true;
    }
  }
  return false;
}

// Follow constants into the SQL call, including concatenation, templates and
// joined arrays. An opaque table name or assignment target fails closed.
function sqlText(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): string {
  const read = (n: ts.Expression) => sqlText(n, checker, new Set(seen));
  if (seen.has(node)) return unknown;
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return read(node.expression);
  if (ts.isIdentifier(node)) {
    const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.parent.flags & ts.NodeFlags.Const &&
      decl.initializer
    )
      return read(decl.initializer);
  }
  if (ts.isConditionalExpression(node)) {
    // The SQLite adapter accepts either a bare pragma or one already prefixed
    // with PRAGMA. Both arms have the same known command at the query call.
    const prefix = /^(\w+)\.toUpperCase\(\)\.startsWith\((["'])(\w+)\2\)$/.exec(
      node.condition.getText()
    );
    const otherwise = read(node.whenFalse);
    if (prefix && prefix[1] === node.whenTrue.getText() && otherwise === prefix[3] + " " + unknown)
      return otherwise;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return read(node.left) + read(node.right);
  if (ts.isTemplateExpression(node))
    return (
      node.head.text + node.templateSpans.map((s) => read(s.expression) + s.literal.text).join("")
    );
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join"
  ) {
    const array = node.expression.expression;
    const separator = node.arguments[0] ? read(node.arguments[0]) : ",";
    if (ts.isArrayLiteralExpression(array)) return array.elements.map(read).join(separator);
    if (ts.isIdentifier(array)) {
      const symbol = checker.getSymbolAtLocation(array);
      const decl = symbol?.valueDeclaration;
      if (
        decl &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isArrayLiteralExpression(decl.initializer)
      ) {
        const declarationName = decl.name;
        const entries = [...decl.initializer.elements];
        // Account for optional assignments pushed before the join. Other
        // mutations or passing the array to a helper make its contents opaque.
        function escapes(n: ts.Node): true | undefined {
          if (
            ts.isIdentifier(n) &&
            n !== declarationName &&
            checker.getSymbolAtLocation(n) === symbol
          ) {
            const access = n.parent;
            if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(access.parent))
              return true;
            if (access.name.text === "push" && access.getStart() < node.getStart())
              entries.push(...access.parent.arguments);
            else if (access.name.text !== "join") return true;
          }
          return ts.forEachChild(n, escapes);
        }
        if (!escapes(decl.getSourceFile())) return entries.map(read).join(separator);
      }
    }
  }
  return unknown;
}

function violations(file: ts.SourceFile, checker: ts.TypeChecker, db: Database.Database): string[] {
  const found: string[] = [];
  const relative = path.relative(backend, file.fileName);
  const namedFixture = relative === "cli.ts" || relative === seed;
  function visit(node: ts.Node): void {
    if (!namedFixture && ts.isIdentifier(node) && node.text === "prepareWorkspaceFixture") {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(
        `${relative}:${line} only the integration CLI and demo seed use prepareWorkspaceFixture`
      );
    }
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : ts.isIdentifier(callee)
            ? callee.text
            : "";
      const receiver =
        ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
          ? callee.expression
          : undefined;
      const arg = node.arguments[0];
      const dbMethod = ["prepare", "exec", "query"].includes(method);
      // A raw Bun database can also run SQL directly. A prepared statement's
      // run() takes bound values instead.
      const prepared =
        receiver &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        ["prepare", "query"].includes(receiver.expression.name.text);
      const directRun = method === "run" && !prepared;
      if (!dbMethod && !directRun) return ts.forEachChild(node, visit);
      const sql = sqlText(arg, checker);
      const decl = ts.isIdentifier(arg) && checker.getSymbolAtLocation(arg)?.declarations?.[0];
      // The Bun adapter wraps database.prepare with a function that forwards
      // its SQL parameter verbatim. Its callers supply the inspected SQL.
      const forwarding =
        decl && ts.isParameter(decl) && ts.isArrowFunction(decl.parent)
          ? decl.parent.parent
          : undefined;
      const forwardedParameter =
        !receiver &&
        forwarding &&
        ts.isBinaryExpression(forwarding) &&
        ts.isPropertyAccessExpression(forwarding.left) &&
        forwarding.left.name.text === method;
      const schema =
        (relative === "src/lib/database.ts" || relative === seed) &&
        decl &&
        ts.isImportSpecifier(decl) &&
        ["SCHEMA_SQL", "BACKFILL_SQL"].includes((decl.propertyName ?? decl.name).text) &&
        ["@shared/schema", "../../shared/schema"].includes(
          (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text
        );
      const regexExec =
        method === "exec" &&
        receiver &&
        checker.typeToString(checker.getTypeAtLocation(receiver)) === "RegExp";
      if (
        !schema &&
        !regexExec &&
        !forwardedParameter &&
        (!directRun || /^\s*(?:with|update|insert|replace|delete)\b/i.test(sql)) &&
        writesLifecycle(sql, db)
      ) {
        const line = file.getLineAndCharacterOfPosition(arg.getStart(file)).line + 1;
        found.push(
          `${path.relative(backend, file.fileName)}:${line} ${sql.trim().replace(/\s+/g, " ")}`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

it("keeps workspace lifecycle writes and deletion in the owner", () => {
  // Schema creation/backfill lives in shared/schema.ts. Unit, integration
  // and e2e fixtures live outside src. The CLI and demo seed are checked too.
  const files = readdirSync(path.join(backend, "src"), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(?:[cm]?[jt]sx?|sql)$/.test(f))
    .map((f) => `src/${f}`)
    .concat("cli.ts", seed)
    .filter((f) => f !== owner);
  const paths = files.map((f) => path.resolve(backend, f));
  const program = ts.createProgram(
    paths.filter((f) => !f.endsWith(".sql")),
    {
      noResolve: true,
      types: [],
      allowJs: true,
      target: ts.ScriptTarget.Latest,
    }
  );
  const checker = program.getTypeChecker();
  const db = guardedSchema();
  const errors = paths.flatMap((file) =>
    file.endsWith(".sql")
      ? writesLifecycle(readFileSync(file, "utf8"), db)
        ? [file]
        : []
      : violations(program.getSourceFile(file)!, checker, db)
  );
  db.close();
  expect(errors).toEqual([]);
});

it("checks assembled statements and distinguishes assignment targets from reads", () => {
  const file = "examples.ts";
  const source = [
    'const table = "work" + "spaces";',
    'const head = "UPDATE " + table + " SET ";',
    'const safe = ["status = ?", "title = state", "current_session_id = ?"];',
    'const edits = ["status = ?"];',
    'edits.push("init_stage = ?");',
    'const labels = ["status = ?"]; if (rename) labels.push("title = ?");',
    'db.prepare(head + labels.join(", "));',
    'db.prepare(head + safe.join(", "));',
    'db.prepare(head + edits.join(", ")); // reject',
    'db.exec(`UPDATE ${table} SET (title, "error_detail") = (?, ?) WHERE id = ?`); // reject',
    "db.exec(`INSERT OR IGNORE INTO ${table} (id, init_fetch_issue) VALUES (?, ?)`); // reject",
    'db.prepare("REPLACE INTO main.[workspaces] (id, title) VALUES (?, ?)"); // reject',
    'const upsert = "INSERT INTO workspaces (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ";',
    'db.prepare(upsert + "status = excluded.status WHERE state = ?");',
    'db.prepare(upsert + "error_message = excluded.title"); // reject',
    'db.exec("UPDATE workspaces SET title = ?; DELETE /* cleanup */ FROM workspaces"); // reject',
    "db.prepare(`UPDATE workspaces SET title = ? WHERE state IN (${placeholders})`);",
    'db.prepare("UPDATE automation_runs SET error_message = ?");',
    'let sql = head + "title = ?"; sql += ", setup_status = ?";',
    "db.exec(sql); // reject",
    'db.query("DELETE FROM " + table); // reject',
    'db.run("DELETE FROM " + table); // reject',
    'db["prepare"](head + "setup_status = ?"); // reject',
    'db.exec("UPDATE[workspaces] SET title = state");',
    'db.exec("UPDATE[workspaces] SET state = title"); // reject',
    'db.exec(`DELETE FROM"workspaces"`); // reject',
    "db.prepare(`UPDATE ${unresolvedTable} SET state = ?`); // reject",
    "db.prepare(`INSERT INTO workspaces (${unresolvedColumns}) VALUES (?)`); // reject",
    'prepareWorkspaceFixture(db, "cli"); // reject',
  ];
  const host = ts.createCompilerHost({});
  const ast = ts.createSourceFile(file, source.join("\n"), ts.ScriptTarget.Latest, true);
  const program = ts.createProgram(
    [file],
    { noLib: true, types: [] },
    {
      ...host,
      getSourceFile: (name) => (name === file ? ast : undefined),
    }
  );
  const db = guardedSchema();
  const found = violations(ast, program.getTypeChecker(), db);
  db.close();
  const badLines = source.flatMap((line, index) => (line.endsWith("// reject") ? [index + 1] : []));
  expect(found.map((message) => Number(message.match(/:(\d+) /)?.[1]))).toEqual(badLines);
});
