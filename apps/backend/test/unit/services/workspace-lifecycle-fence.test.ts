import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { SCHEMA_SQL } from "@shared/schema";
import { expect, it } from "vitest";

const backend = path.resolve(__dirname, "../../..");
const owner = "src/services/workspace-lifecycle.ts";
const titleOwner = "src/db/queries.ts";
const unknown = "«dynamic»";
const ownedDeletes = ["workspaces", "repositories"];
const titledTables = ["workspaces", "sessions"];
const guardedTables = [...new Set([...ownedDeletes, ...titledTables])];
const protectedColumns = new Set([
  "state",
  "init_stage",
  "setup_status",
  "init_fetch_issue",
  "error_message",
  "error_detail",
  "archived_at",
  "archived_by",
]);

// Let SQLite parse the assignments, including tuple SETs and ON CONFLICT.
// Generated columns forbid even INSERTs. UPDATE OF title and DELETE triggers
// fail on a deliberately missing function at prepare time. No statement runs.
function guardedSchema(writer = "") {
  const schema = new Database(":memory:");
  schema.exec(SCHEMA_SQL);
  const columns = schema.pragma("table_info(workspaces)") as { name: string; pk: number }[];
  schema.close();
  const guard = new Database(":memory:");
  const definitions = columns.map(({ name, pk }) =>
    writer !== owner && protectedColumns.has(name)
      ? `${name} AS (NULL)`
      : pk
        ? `${name} PRIMARY KEY`
        : name
  );
  guard.exec(`CREATE TABLE workspaces (${definitions.join(", ")})`);
  guard.exec(SCHEMA_SQL);
  guard.pragma("recursive_triggers = ON"); // REPLACE also deletes its conflicting row.
  for (const table of writer === owner ? [] : ownedDeletes) {
    guard.exec(
      `CREATE TRIGGER fence_delete_${table} BEFORE DELETE ON ${table} BEGIN SELECT forbidden_delete(); END`
    );
  }
  for (const table of writer === titleOwner ? [] : titledTables) {
    guard.exec(
      `CREATE TRIGGER fence_title_${table} BEFORE UPDATE OF title ON ${table} BEGIN SELECT forbidden_title(); END`
    );
  }
  return { db: guard, writer };
}

type Guard = ReturnType<typeof guardedSchema>;
function writesOutsideOwner(sql: string, { db, writer }: Guard, directRun = false) {
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
    if (directRun && !/^(?:with|update|insert|replace|delete)\b/i.test(raw)) continue;
    // An unresolved head or a write target that could resolve to a guarded table
    // cannot establish ownership. Other tables may build their own SQL.
    if (raw.split(/\s+/, 1)[0].includes(unknown)) return true;
    const target =
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\b(?:update(?:\s+or\s+\w+)?|(?:insert(?:\s+or\s+\w+)?|replace)\s+into|delete\s+from)\b\s*(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?([\w«»]*)["'`\]]?/gi;
    const matches = [...raw.matchAll(target)].filter((match) => match[1] !== undefined);
    // REPLACE can replace a title even when the statement omits the column.
    if (
      writer !== titleOwner &&
      matches.some(
        ([verb, table]) =>
          /^(?:insert\s+or\s+|update\s+or\s+)?replace\b/i.test(verb) &&
          titledTables.includes(table.toLowerCase())
      )
    )
      return true;
    const targets = matches.map((match) => match[1].toLowerCase());
    if (
      targets.some(
        (t) =>
          t.includes(unknown) &&
          guardedTables.some((table) => table.startsWith(t.split(unknown)[0]))
      )
    )
      return true;
    if (!guardedTables.some((table) => targets.includes(table))) continue;
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

function violations(file: ts.SourceFile, checker: ts.TypeChecker, guard: Guard): string[] {
  const found: string[] = [];
  const relative = path.relative(backend, file.fileName);
  function visit(node: ts.Node): void {
    if (
      relative !== owner &&
      relative !== "cli.ts" &&
      ts.isIdentifier(node) &&
      node.text === "insertWorkspaceFixture"
    ) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(`${relative}:${line} only the integration CLI uses insertWorkspaceFixture`);
    }
    if (
      relative !== owner &&
      relative !== "src/services/setup-status.ts" &&
      ts.isIdentifier(node) &&
      node.text === "writeSetupStatusFile"
    ) {
      found.push(
        `${relative}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} the lifecycle owner writes the setup status mirror`
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
        relative === "src/lib/database.ts" &&
        decl &&
        ts.isImportSpecifier(decl) &&
        ["SCHEMA_SQL", "BACKFILL_SQL"].includes((decl.propertyName ?? decl.name).text) &&
        (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text === "@shared/schema";
      const regexExec =
        method === "exec" &&
        receiver &&
        checker.typeToString(checker.getTypeAtLocation(receiver)) === "RegExp";
      if (
        !schema &&
        !regexExec &&
        !forwardedParameter &&
        writesOutsideOwner(sql, guard, directRun)
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

it("keeps lifecycle writes, deletions and title updates in their owners", () => {
  // Schema creation/backfill lives in shared/schema.ts. Unit, integration
  // and e2e fixtures live outside src. The integration CLI is checked too.
  const files = ["src", "../agent-server"]
    .flatMap((dir) =>
      readdirSync(path.join(backend, dir), { recursive: true, encoding: "utf8" })
        .filter((f) => /\.(?:[cm]?[jt]sx?|sql)$/.test(f) && !f.includes("node_modules/"))
        .map((f) => path.join(dir, f))
    )
    .concat("cli.ts");
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
  const guards = [guardedSchema(), guardedSchema(owner), guardedSchema(titleOwner)];
  const errors = paths.flatMap((file) => {
    const guard = guards.find((g) => g.writer === path.relative(backend, file)) ?? guards[0]!;
    return file.endsWith(".sql")
      ? writesOutsideOwner(readFileSync(file, "utf8"), guard)
        ? [file]
        : []
      : violations(program.getSourceFile(file)!, checker, guard);
  });
  for (const { db } of guards) db.close();
  expect(errors).toEqual([]);
});

it("checks assembled statements and distinguishes assignment targets from reads", () => {
  const file = path.join(backend, "src/examples.ts");
  const source = [
    'const table = "work" + "spaces";',
    'const head = "UPDATE " + table + " SET ";',
    'const safe = ["status = ?", "pr_url = state", "current_session_id = ?"];',
    'const edits = ["status = ?"];',
    'edits.push("init_stage = ?");',
    'const labels = ["status = ?"]; if (rename) labels.push("pr_url = ?");',
    'db.prepare(head + labels.join(", "));',
    'db.prepare(head + safe.join(", "));',
    'db.prepare(head + edits.join(", ")); // reject',
    'db.exec(`UPDATE ${table} SET (pr_url, "error_detail") = (?, ?) WHERE id = ?`); // reject',
    "db.exec(`INSERT OR IGNORE INTO ${table} (id, init_fetch_issue) VALUES (?, ?)`); // reject",
    'db.prepare("REPLACE INTO main.[workspaces] (id, pr_url) VALUES (?, ?)"); // reject',
    'const upsert = "INSERT INTO workspaces (id, pr_url) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ";',
    'db.prepare(upsert + "status = excluded.status WHERE state = ?");',
    'db.prepare(upsert + "error_message = excluded.pr_url"); // reject',
    'db.prepare(head + "archived_at = CURRENT_TIMESTAMP"); // reject',
    'db.prepare(upsert + "archived_by = excluded.pr_url"); // reject',
    'db.exec("UPDATE workspaces SET pr_url = ?; DELETE /* cleanup */ FROM workspaces"); // reject',
    "db.prepare(`UPDATE workspaces SET pr_url = ? WHERE state IN (${placeholders})`);",
    'db.prepare("UPDATE automation_runs SET error_message = ?");',
    `db.prepare("UPDATE sessions SET error_message = 'replace into sessions'");`,
    `db.prepare("REPLACE INTO 'sessions' (id) VALUES (?)"); // reject`,
    'let sql = head + "pr_url = ?"; sql += ", setup_status = ?";',
    "db.exec(sql); // reject",
    'db.query("DELETE FROM " + table); // reject',
    'db.query("DELETE FROM " + "repositories"); // reject',
    'db.exec("REPLACE INTO main.repositories (id, name) VALUES (?, ?)"); // reject',
    'db.prepare("UPDATE repositories SET name = ?");',
    'db.run("/* archived */ UPDATE workspaces SET state = 1"); // reject',
    'db.run("-- note\\nDELETE FROM workspaces"); // reject',
    'db.run("/* pr_url only */ UPDATE workspaces SET pr_url = state");',
    'db.run("DELETE FROM " + table); // reject',
    'db["prepare"](head + "setup_status = ?"); // reject',
    'db.exec("UPDATE[workspaces] SET pr_url = state");',
    'db.exec("UPDATE[workspaces] SET state = pr_url"); // reject',
    'db.exec(`DELETE FROM"workspaces"`); // reject',
    "db.prepare(`UPDATE ${unresolvedTable} SET state = ?`); // reject",
    "db.prepare(`INSERT INTO workspaces (${unresolvedColumns}) VALUES (?)`); // reject",
    "insertWorkspaceFixture(id, repoId); // reject",
    "writeSetupStatusFile(id, status); // reject",
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
  const guard = guardedSchema();
  const found = violations(ast, program.getTypeChecker(), guard);
  guard.db.close();
  const badLines = source.flatMap((line, index) => (line.endsWith("// reject") ? [index + 1] : []));
  expect(found.map((message) => Number(message.match(/:(\d+) /)?.[1]))).toEqual(badLines);
});

it.each(["another file", owner, titleOwner])("checks each column's owner for %s", (writer) => {
  const guard = guardedSchema(writer);
  try {
    for (const table of titledTables) {
      const insert = `INSERT INTO ${table} (id, title) VALUES (?, ?)`;
      expect(writesOutsideOwner(insert, guard)).toBe(false);
      for (const sql of [
        `UPDATE ${table} SET (title, status) = (?, ?)`,
        `${insert} ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
        `INSERT OR REPLACE INTO ${table} (id, title) VALUES (?, ?)`,
      ]) {
        // Replacing a workspace also deletes it, which belongs to the lifecycle owner.
        expect(writesOutsideOwner(sql, guard)).toBe(
          writer !== titleOwner || (sql.includes("REPLACE") && table === "workspaces")
        );
      }
    }
    expect(writesOutsideOwner("UPDATE workspaces SET state = title", guard)).toBe(writer !== owner);
  } finally {
    guard.db.close();
  }
});

// The owner can publish changes, reset a chat's stream and write its setup-status
// file mirror. Services, including the source of live turn ids, call it from above.
function forbiddenImports(source: string, mirror = false): string[] {
  const file = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function check(specifier: ts.Node | undefined, node: ts.Node) {
    const spec = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : "<dynamic>";
    const only =
      ts.isImportDeclaration(node) && !node.importClause?.name && node.importClause?.namedBindings;
    const allowed = mirror
      ? ["node:fs", "node:os", "node:path"].includes(spec) ||
        (spec === "@shared/enums" && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
      : (spec === "@shared/api/repos" &&
          ts.isImportDeclaration(node) &&
          node.importClause?.isTypeOnly) ||
        ["../db", "../lib/database", "../lib/errors", "@shared/enums", "@shared/lib/uuid"].includes(
          spec
        );
    if (allowed) return;
    const bindings: Record<string, string> = {
      "node:util": "isDeepStrictEqual",
      "./query-engine": "invalidate",
      "./setup-status": "writeSetupStatusFile",
      "./streams": "resetSubscribers",
      "@shared/api/sessions": "sessionEvents",
      "@shared/types/repository": "CLOUD_PROJECT_REMOVAL_REASON",
    };
    const binding = bindings[spec];
    if (
      !mirror &&
      binding &&
      only &&
      ts.isNamedImports(only) &&
      only.elements.length === 1 &&
      (only.elements[0].propertyName ?? only.elements[0].name).text === binding
    )
      return;
    found.push(spec);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      check(node.moduleSpecifier, node);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      check(node.arguments[0], node);
    } else if (ts.isExternalModuleReference(node)) {
      check(node.expression, node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node.argument.literal, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

it("keeps the lifecycle owner below the services that use it", () => {
  expect(forbiddenImports(readFileSync(path.join(backend, owner), "utf8"))).toEqual([]);
  expect(
    forbiddenImports(readFileSync(path.join(backend, "src/services/setup-status.ts"), "utf8"), true)
  ).toEqual([]);
  expect(
    forbiddenImports(`
    import type { RepoRemovalConfirmation } from "@shared/api/repos";
    import { removeRepo } from "@shared/api/repos";
    import type { Stage } from "./workspace-init.service";
    import {helper} from "../lib/reexported-service";
    const agent = import("./agent/cloud/driver");
    export { start } from "../lib/../services/project-environment.service";
    const hidden = require(dynamic);
    import * as queries from "./query-engine";
    import { invalidate } from "./query-engine";
    import { writeSetupStatusFile } from "./setup-status";
    import { resetSubscribers } from "./streams";
    import { sessionEvents } from "@shared/api/sessions";
    import { publish } from "./streams";
    import { liveTurnId } from "./agent/service";
  `)
  ).toEqual([
    "@shared/api/repos",
    "./workspace-init.service",
    "../lib/reexported-service",
    "./agent/cloud/driver",
    "../lib/../services/project-environment.service",
    "<dynamic>",
    "./query-engine",
    "./streams",
    "./agent/service",
  ]);
});
