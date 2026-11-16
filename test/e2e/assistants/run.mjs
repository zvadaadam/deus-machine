// Hosted assistants, end to end on loopback: a stand-in sign-in (the only
// stand-in), Postgres, Deus Cloud's connector from the linked AGNT worktree,
// the relay Worker, and a Deus backend on an isolated database. Deus Cloud only
// carries each MCP message to the computer, which answers it. The assistant is
// the official MCP SDK client, given only the computer's assistant address. No
// model or agent login.
//   AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:assistants
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { importJWK, SignJWT } from "jose";
import { WebSocket } from "ws";
import { RELAY_PROTOCOL } from "../../../shared/types/relay.ts";
import { createStack, freePort, until } from "../remote-access/stack.mjs";
import { assistantFromUrl, connectWithToken, localWindow, rawCall, rawMcp } from "./clients.mjs";
import { startIssuer } from "./issuer.mjs";

const agnt = process.env.AGNT_WORKSPACE;
assert(agnt, "Set AGNT_WORKSPACE to the linked AGNT worktree (Deus Cloud runs from it)");
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/assistants-e2e");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = { directory, checks: [], evidence: {} };
const check = (name, evidence) => {
  report.checks.push(name);
  if (evidence !== undefined) report.evidence[name] = evidence;
  console.log(`PASS: ${name}`);
};

// The operator module's words, which the computer and Deus Cloud must pass on unchanged.
const NOT_ALLOWED_YET =
  "This assistant is signed in but not allowed on this computer yet. Ask the person to open Deus on the computer (Settings, Remote access, Assistants) and allow it, then try again.";
const READ_ONLY =
  "This assistant may only read on this computer. Nothing was done. The person can allow more in Deus: Settings, Remote access, Assistants.";
const SESSION_TOOLS = [
  "list_sessions",
  "read_session",
  "start_session",
  "send_message",
  "wait_for_session",
  "watch_sessions",
  "answer_request",
  "stop_session",
];
const READ_ONLY_TOOLS = [
  "list_sessions",
  "read_session",
  "wait_for_session",
  "watch_sessions",
  "read_changes",
  "send_feedback",
];
/** The tools that may undo or lose work: MCP's destructiveHint. */
const DESTRUCTIVE_TOOLS = ["stop_session", "archive_workspace"];

/** A line in a file that is not changed: no assistant may read it. */
const SECRET = "STRIPE_SECRET_KEY=sk_live_e2e_must_never_leak";

/**
 * Seeded workspaces beside the stack's own: a conversation to read, one to
 * archive, one that failed, and a cloud workspace no assistant may meet.
 */
function seedConversations(database) {
  const db = new Database(database);
  const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const repository = db.prepare("SELECT id FROM repositories").get().id;
  const workspace = (slug, title, status, errorMessage = null, cloud = false) => {
    const workspaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO workspaces (id, repository_id, slug, title, state, kind, provider_workspace_id) VALUES (?, ?, ?, ?, 'ready', ?, ?)"
    ).run(
      workspaceId,
      repository,
      slug,
      title,
      cloud ? "cloud" : "worktree",
      cloud ? "ws_e2e_cloud" : null
    );
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, title, error_message, provider_session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(sessionId, workspaceId, status, title, errorMessage, cloud ? "ses_e2e_cloud" : null);
    db.prepare("UPDATE workspaces SET current_session_id = ? WHERE id = ?").run(
      sessionId,
      workspaceId
    );
    return { workspaceId, sessionId };
  };
  const message = (sessionId, role, turnId, minutesAgo, parts) => {
    const messageId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO messages (id, session_id, role, turn_id, model, sent_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      messageId,
      sessionId,
      role,
      turnId,
      role === "assistant" ? "haiku" : null,
      iso(minutesAgo)
    );
    parts.forEach((part, seq) => {
      const id = crypto.randomUUID();
      const data = { ...part, id, sessionId, messageId };
      db.prepare(
        `INSERT INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        messageId,
        sessionId,
        seq,
        part.type,
        JSON.stringify(data),
        part.toolCallId ?? null,
        part.toolName ?? null
      );
    });
  };

  const voyager = workspace("voyager", "Totals for the cart", "idle");
  // Its folder: a git checkout with one changed file, and a secret beside it that is not changed.
  const { root_path: rootPath } = db.prepare("SELECT root_path FROM repositories").get();
  const folder = path.join(rootPath, ".deus", "voyager");
  mkdirSync(folder, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: folder, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(path.join(folder, ".gitignore"), ".env\n");
  writeFileSync(path.join(folder, "price.js"), "export const zero = 0;\n");
  git("add", ".");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-m", "Initial");
  writeFileSync(
    path.join(folder, "price.js"),
    "export const zero = 0;\nexport function total(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n"
  );
  writeFileSync(path.join(folder, ".env"), `${SECRET}\n`);
  db.prepare(
    "UPDATE workspaces SET git_branch = 'main', git_target_branch = 'main' WHERE id = ?"
  ).run(voyager.workspaceId);
  const turn = crypto.randomUUID();
  message(voyager.sessionId, "user", turn, 30, [
    { type: "text", text: "Add a total() helper to price.js that sums price times quantity." },
  ]);
  message(voyager.sessionId, "assistant", turn, 29, [
    {
      type: "tool",
      toolCallId: "toolu_e2e_1",
      toolName: "Edit",
      kind: "edit",
      title: "Edit price.js",
      state: {
        status: "completed",
        input: { file_path: "price.js" },
        output: "The file price.js has been updated.",
        time: { start: Date.now() - 29 * 60_000, end: Date.now() - 29 * 60_000 + 800 },
      },
    },
    { type: "text", text: "Added total(items) to price.js; it sums price times quantity." },
  ]);
  const harbor = workspace("harbor", "Old experiment", "idle");
  workspace("atlas", "Broken build", "error", "The agent stopped: usage limit reached");
  const nimbus = workspace("nimbus", "Cloud refactor", "idle", null, true);
  message(nimbus.sessionId, "user", crypto.randomUUID(), 20, [
    { type: "text", text: "Refactor the checkout in the cloud." },
  ]);
  // A project with no workspace yet: still a place an assistant can start one.
  const emptyFolder = path.join(rootPath, "..", "empty-shop");
  mkdirSync(emptyFolder, { recursive: true });
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Empty shop', ?)").run(
    crypto.randomUUID(),
    emptyFolder
  );
  db.close();
  return { voyager, harbor, nimbus };
}

const stack = createStack({ root, agnt, directory });
const issuer = await startIssuer();
const windows = [];
try {
  // ---- Stack ----
  const pg = await stack.postgres();
  pg.sql(
    `INSERT INTO accounts (id, name, email, created_at) VALUES
       ('user_alice', 'Alice', 'alice@example.com', now()::text),
       ('user_bob', 'Bob', 'bob@example.com', now()::text)`
  );
  const { signingKey, jwks } = await stack.keys();
  const jwtSecret = crypto.randomUUID();
  const [cloudPort, relayPort] = [await freePort(), await freePort()];
  const relay = await stack.relay({
    port: relayPort,
    jwks,
    persist: path.join(directory, "relay"),
  });

  const cloud = await stack.cloud({
    port: cloudPort,
    databaseUrl: pg.url,
    jwtSecret,
    signingKey,
    persist: path.join(directory, "cloud-state"),
    vars: {
      ASSISTANT_ISSUER: issuer.url,
      RELAY_URL: relay.ws,
      // No origins configured: a web page is refused all the same.
    },
  });
  const sessions = {
    aliceDesktop: await stack.session(jwtSecret, "user_alice", "deus-machine-desktop"),
    aliceWeb: await stack.session(jwtSecret, "user_alice", "deus-web"),
  };

  const hostDb = await stack.hostDatabase("Studio Mac", "Seeded workspace");
  const seeded = seedConversations(hostDb.database);
  const spawnToken = crypto.randomUUID();
  const startHost = () =>
    stack.host({
      name: "Studio Mac",
      ...hostDb,
      relayUrl: relay.ws,
      authToken: spawnToken,
      env: { DEUS_ASSISTANT_ISSUER: issuer.url },
    });
  let host = await startHost();
  const signIn = () =>
    host.api("/settings/cloud/credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${spawnToken}` },
      body: { deusCloudUrl: cloud.base, deusCloudSessionToken: sessions.aliceDesktop },
    });
  const connected = async () => {
    let status;
    await until(
      async () => (status = await host.api("/relay/status")).state === "connected",
      30_000,
      "the computer's tunnel"
    );
    return status.serverId;
  };
  await signIn();
  const machineId = await connected();
  const openWindow = async () => {
    const opened = await localWindow(host.url);
    windows.push(opened);
    return opened;
  };
  let mac = await openWindow();
  const listed = () => mac.request("assistants");
  const readDb = (statement, ...args) => {
    const db = new Database(hostDb.database, { readonly: true });
    try {
      return db.prepare(statement).get(...args);
    } finally {
      db.close();
    }
  };

  // ---- 1. The address and the connector's refusals before any sign-in ----
  const { assistantUrl } = await mac.request("relayStatus");
  const url = `${cloud.base}/mcp/${machineId}`;
  assert.equal(assistantUrl, url);
  const metadataUrl = `${cloud.base}/.well-known/oauth-protected-resource/mcp/${machineId}`;
  const bare = await rawMcp(url);
  assert.equal(bare.status, 401);
  assert.equal(bare.challenge, `Bearer resource_metadata="${metadataUrl}"`);
  const metadata = await (await fetch(metadataUrl)).json();
  assert.deepEqual(metadata, {
    resource: url,
    authorization_servers: [issuer.url],
    bearer_methods_supported: ["header"],
  });
  const get = await rawMcp(url, { method: "GET" });
  assert.equal(get.status, 405);
  const page = await rawMcp(url, { headers: { origin: "https://evil.example" } });
  assert.equal(page.status, 403);
  check(
    "The computer shows its assistant address; with no token the connector answers 401 with the challenge and the resource's metadata names the sign-in; GET is 405 and a web page's Origin is 403 (with no origins configured)",
    {
      address: assistantUrl,
      challenge: bare.challenge,
      metadata,
      get: get.status,
      origin: page.text,
    }
  );

  // ---- 2. From the URL alone ----
  issuer.signInAs("user_alice", "org_e2e");
  const chatgpt = await assistantFromUrl(assistantUrl, {
    name: "ChatGPT",
    redirect: "https://chatgpt.com/connector_platform_oauth_redirect",
  });
  const flow = chatgpt.trace.join("\n");
  for (const step of [
    new RegExp(`POST ${url} 401`),
    new RegExp(`GET ${metadataUrl} 200`),
    new RegExp(`GET ${issuer.url}/.well-known/oauth-authorization-server 200`),
    new RegExp(`POST ${issuer.url}/oauth2/register 201`),
    new RegExp(`GET ${issuer.url}/oauth2/authorize 302`),
    new RegExp(`POST ${issuer.url}/oauth2/token 200`),
    new RegExp(`POST ${url} 200`),
  ]) {
    assert.match(flow, step);
  }
  // Connected (initialize and its notification only, both carried to the
  // computer, which answered them): it lists the assistant already, with no
  // background announce and no wait.
  assert.deepEqual(
    chatgpt.trace.filter((t) => t.startsWith(`POST ${url} `)),
    [`POST ${url} 401`, `POST ${url} 200`, `POST ${url} 202`],
    "initialize and its notification only"
  );
  const afterInitialize = await listed();
  assert.deepEqual(
    afterInitialize.map((a) => [a.clientId, a.access]),
    [[chatgpt.clientId, "pending"]]
  );
  const serverInfo = chatgpt.client.getServerVersion();
  assert.equal(serverInfo?.name, "deus");
  assert.equal(serverInfo?.title, "Deus on Studio Mac");
  assert(chatgpt.client.getInstructions(), "the computer's instructions");
  check(
    'initialize is answered by the computer itself (server info "Deus on Studio Mac" with instructions); right after initialize alone (no tools/list yet, no announce) the assistant is already listed on the computer as pending',
    { trace: [...chatgpt.trace], serverInfo, assistants: afterInitialize }
  );
  const { tools } = await chatgpt.client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...SESSION_TOOLS, "read_changes", "archive_workspace", "add_project", "send_feedback"]
  );
  for (const tool of tools) {
    assert.equal(
      tool.annotations?.readOnlyHint,
      READ_ONLY_TOOLS.includes(tool.name),
      `${tool.name}'s readOnlyHint`
    );
    assert.equal(
      tool.annotations?.destructiveHint,
      DESTRUCTIVE_TOOLS.includes(tool.name),
      `${tool.name}'s destructiveHint`
    );
  }
  check(
    "From the URL alone the MCP SDK client meets the 401, reads the metadata, registers, signs in and connects; it is offered the eight session tools and Deus's three, with read-only and destructive hints set",
    {
      trace: chatgpt.trace,
      tools: tools.map((t) => `${t.name}${t.annotations.readOnlyHint ? "" : "*"}`),
    }
  );

  // ---- 3. Pending ----
  let assistants = await listed();
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].clientId, chatgpt.clientId);
  assert.equal(assistants[0].access, "pending");
  const pendingCall = await chatgpt.call("list_sessions");
  assert.equal(pendingCall.isError, true);
  assert.equal(pendingCall.text, NOT_ALLOWED_YET);
  check(
    "A new assistant is pending on the computer, and its tool call is refused with the not-allowed-yet sentence",
    { assistants, refusal: pendingCall.text }
  );

  // ---- 4. The label ----
  // Deus Cloud's label route asks WorkOS (a fixed URL), and this stack has no
  // WorkOS key: it says so, and the computer keeps its documented fallback.
  const label = await fetch(`${cloud.base}/me/assistants/${chatgpt.clientId}`, {
    headers: { authorization: `Bearer ${sessions.aliceDesktop}` },
  });
  assert.equal(label.status, 503);
  const labelFromWeb = await fetch(`${cloud.base}/me/assistants/${chatgpt.clientId}`, {
    headers: { authorization: `Bearer ${sessions.aliceWeb}` },
  });
  assert.equal(labelFromWeb.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assistants = await listed();
  assert.equal(assistants[0].name, chatgpt.clientId);
  assert.equal(assistants[0].host, null);
  check(
    "The label: Deus Cloud's lookup calls WorkOS at a fixed URL, so it cannot be pointed at a stub; without a WorkOS key it answers 503 (403 to a web session), and the computer shows the documented fallback: name = client id, host = null",
    { listed: assistants[0], cloudLookup: await label.json() }
  );

  // ---- 5. Read only ----
  await mac.mutate("setAssistantAccess", { clientId: chatgpt.clientId, access: "read" });
  const list = await chatgpt.call("list_sessions");
  assert.equal(list.isError, false, list.text);
  assert.match(list.text, /^4 session\(s\)/);
  assert.match(list.text, /voyager\s+idle/);
  assert.match(list.text, /atlas\s+error/);
  assert.match(list.text, /"Totals for the cart"/);
  assert.match(list.text, /\nproject Empty shop {2}\(no sessions\)/);
  const read = await chatgpt.call("read_session", { session: "voyager" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Add a total\(\) helper to price\.js/);
  assert.match(read.text, /Added total\(items\) to price\.js/);
  assert.match(read.text, /Edit/);
  const write = await chatgpt.call("archive_workspace", { session: "harbor" });
  assert.equal(write.isError, true);
  assert.equal(write.text, READ_ONLY);
  const stopRead = await chatgpt.call("stop_session", { session: "voyager" });
  assert.equal(stopRead.text, READ_ONLY);
  const changedRead = await chatgpt.call("read_changes", { session: "voyager" });
  assert.equal(changedRead.isError, false, changedRead.text);
  assert.match(changedRead.text, /price\.js/);
  assert.doesNotMatch(changedRead.text, /\.env/);
  const secretRead = await chatgpt.call("read_changes", { session: "voyager", file: ".env" });
  assert.equal(secretRead.isError, true, secretRead.text);
  assert(!secretRead.text.includes("sk_live"), "no content of an unchanged file");
  assert.equal(
    readDb("SELECT state FROM workspaces WHERE id = ?", seeded.harbor.workspaceId).state,
    "ready"
  );
  check(
    "Allowed as Read only: list_sessions shows the seeded workspaces with their phases and a project with no workspace as (no sessions), read_session the seeded conversation, and a tool that changes something is refused with the read-only sentence",
    { list: list.text, read: read.text, refusal: write.text }
  );
  check(
    "Read only: read_changes lists the changed file, and read_changes on a file that is not changed (a seeded .env) is refused and shows none of its content",
    { changes: changedRead.text, refusal: secretRead.text }
  );

  // ---- 6. Operate ----
  await mac.mutate("setAssistantAccess", { clientId: chatgpt.clientId, access: "operate" });
  const archived = await chatgpt.call("archive_workspace", { session: "harbor" });
  assert.equal(archived.isError, false, archived.text);
  assert.match(archived.text, /^archived "harbor"/);
  await until(
    () =>
      readDb("SELECT state FROM workspaces WHERE id = ?", seeded.harbor.workspaceId).state ===
      "archived",
    10_000,
    "harbor archived"
  );
  const afterArchive = await chatgpt.call("list_sessions");
  assert.doesNotMatch(afterArchive.text, /harbor/);
  const stopIdle = await chatgpt.call("stop_session", { session: "voyager" });
  assert.equal(stopIdle.isError, false, stopIdle.text);
  assert.equal(stopIdle.text, '"voyager" is not working; nothing to stop.');
  const secretOperate = await chatgpt.call("read_changes", { session: "voyager", file: ".env" });
  assert.equal(secretOperate.isError, true, secretOperate.text);
  assert(!secretOperate.text.includes("sk_live"), "no content of an unchanged file");
  const diffOperate = await chatgpt.call("read_changes", { session: "voyager", file: "price.js" });
  assert.match(diffOperate.text, /export function total/);
  const unknown = await chatgpt.call("read_session", { session: "nowhere" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No session "nowhere"/);
  assert.doesNotMatch(unknown.text, /nimbus/);
  check(
    "Raised to Operate: archive_workspace archives the workspace in the computer's database, stop_session on an idle chat says nothing was running, and an unknown session is named with the known ones",
    { archived: archived.text, stop: stopIdle.text, unknown: unknown.text }
  );
  check(
    "Operate: read_changes on the unchanged .env is still refused with none of its content, while a changed file's diff is shown",
    { refusal: secretOperate.text, diff: diffOperate.text }
  );

  // ---- 6b. A cloud workspace is not an assistant's ----
  const windowSees = (await mac.request("workspaces"))
    .flatMap((g) => g.workspaces)
    .find((w) => w.id === seeded.nimbus.workspaceId);
  assert.equal(windowSees?.kind, "cloud", "the computer's own window lists the cloud workspace");
  const cloudList = await chatgpt.call("list_sessions");
  assert.match(cloudList.text, /^3 session\(s\)/);
  assert.doesNotMatch(cloudList.text, /nimbus|Cloud refactor/);
  const nimbusRefusals = {};
  for (const [what, tool, args] of [
    ["read by name", "read_session", { session: "nimbus" }],
    ["read by group/name", "read_session", { session: "Remote test/nimbus" }],
    ["read by its chat's id", "read_session", { session: seeded.nimbus.sessionId }],
    ["read by its workspace's id", "read_session", { session: seeded.nimbus.workspaceId }],
    ["changes", "read_changes", { session: seeded.nimbus.sessionId }],
    ["send by name", "send_message", { session: "nimbus", message: "Ship it.", wait: 0 }],
    [
      "send by id",
      "send_message",
      { session: seeded.nimbus.sessionId, message: "Ship it.", wait: 0 },
    ],
    ["stop by id", "stop_session", { session: seeded.nimbus.sessionId }],
    ["archive by id", "archive_workspace", { session: seeded.nimbus.sessionId }],
  ]) {
    const answer = await chatgpt.call(tool, args);
    assert.equal(answer.isError, true, `${what}: ${answer.text}`);
    assert.doesNotMatch(answer.text, /Refactor the checkout|Cloud refactor/, what);
    nimbusRefusals[what] = answer.text;
  }
  assert.equal(
    readDb("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", seeded.nimbus.sessionId).n,
    1,
    "nothing was sent to the cloud chat"
  );
  assert.equal(
    readDb("SELECT state FROM workspaces WHERE id = ?", seeded.nimbus.workspaceId).state,
    "ready"
  );
  check(
    "A cloud workspace seeded in the computer's database (listed by its own window) is not in an assistant's list, is not found by name, group/name, chat id or workspace id, and cannot be read, sent to, stopped or archived: its chat still has its one message",
    { list: cloudList.text, refusals: nimbusRefusals }
  );

  // ---- 7. A second assistant on the same account ----
  const claude = await assistantFromUrl(assistantUrl, {
    name: "Claude",
    redirect: "https://claude.ai/api/mcp/auth_callback",
  });
  assert.notEqual(claude.clientId, chatgpt.clientId);
  const second = await claude.call("list_sessions");
  assert.equal(second.text, NOT_ALLOWED_YET);
  assistants = await listed();
  assert.deepEqual(
    assistants.map((a) => [a.clientId, a.access]).sort(),
    [
      [chatgpt.clientId, "operate"],
      [claude.clientId, "pending"],
    ].sort()
  );
  assert.equal((await chatgpt.call("list_sessions")).isError, false);
  check(
    "A second assistant on the same account waits for its own approval; the first keeps its access",
    { assistants }
  );

  // ---- 8. Refusals at the connector ----
  const otherComputer = await issuer.mint({
    sub: "user_alice",
    resource: `${cloud.base}/mcp/0123456789abcdef`,
    client: chatgpt.clientId,
  });
  const expired = await issuer.mint({
    sub: "user_alice",
    resource: url,
    client: chatgpt.clientId,
    seconds: -60,
  });
  const forged = await issuer.mint({
    sub: "user_alice",
    resource: url,
    client: chatgpt.clientId,
    key: await issuer.foreignKey(),
  });
  const otherIssuer = await issuer.mint({
    sub: "user_alice",
    resource: url,
    client: chatgpt.clientId,
    issuer: "https://another-issuer.example",
  });
  const refusals = {};
  for (const [what, token] of [
    ["issued for another computer's address", otherComputer],
    ["expired", expired],
    ["signed with a key the issuer does not publish", forged],
    ["from another issuer", otherIssuer],
  ]) {
    const answer = await rawMcp(url, { token });
    assert.equal(answer.status, 401, what);
    assert.equal(answer.challenge, `Bearer resource_metadata="${metadataUrl}"`, what);
    refusals[what] = answer.status;
  }
  // Bob signs in properly, for Alice's computer's address.
  issuer.signInAs("user_bob", null);
  const bobToken = await issuer.mint({ sub: "user_bob", resource: url, client: chatgpt.clientId });
  const bobAtCloud = await rawCall(url, bobToken, "list_sessions");
  // Deus Cloud's refusal of a tool call is a tool result marked as an error.
  assert.equal(bobAtCloud.status, 200, bobAtCloud.text);
  assert.equal(bobAtCloud.json?.result?.isError, true, bobAtCloud.text);
  assert.match(bobAtCloud.message, /not on the Deus account you signed in with/);
  const bobInitialize = await rawMcp(url, {
    token: bobToken,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
    },
  });
  // Any other method keeps MCP's protocol error.
  assert.equal(bobInitialize.json?.error?.code, -32001);
  assert.match(bobInitialize.json?.error?.message, /not on the Deus account you signed in with/);
  refusals["another account (Deus Cloud)"] = bobAtCloud.message;

  // Defense in depth: as if Deus Cloud erred and carried Bob's (or a misaddressed)
  // token to Alice's computer, with a valid client ticket for Alice's account.
  const ticketKey = await importJWK(JSON.parse(signingKey), "ES256");
  const aliceTicket = () =>
    new SignJWT({ mid: machineId, role: "client" })
      .setProtectedHeader({
        alg: "ES256",
        typ: "deus-relay-ticket+jwt",
        kid: JSON.parse(signingKey).kid,
      })
      .setIssuer("deus-cloud")
      .setAudience("deus-relay")
      .setSubject("user_alice")
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(ticketKey);
  const presentToComputer = async (token) => {
    const ws = new WebSocket(`${relay.ws}/api/servers/${machineId}/connect`, [
      RELAY_PROTOCOL,
      await aliceTicket(),
    ]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer from the computer")), 15_000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "authenticate", token })));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "authenticated" || frame.type === "auth_failed") {
          clearTimeout(timer);
          ws.close();
          resolve(frame);
        }
      });
      ws.on("error", reject);
    });
  };
  const bobAtComputer = await presentToComputer(bobToken);
  assert.equal(bobAtComputer.type, "auth_failed");
  assert.match(bobAtComputer.message, /different Deus account/);
  const misaddressed = await presentToComputer(otherComputer);
  assert.equal(misaddressed.type, "auth_failed");
  assert.match(misaddressed.message, /for another computer/);
  const expiredAtComputer = await presentToComputer(expired);
  assert.match(expiredAtComputer.message, /expired/);
  assert.equal((await listed()).length, 2, "no refused token became an assistant");
  refusals["another account (the computer, if Deus Cloud erred)"] = bobAtComputer.message;
  refusals["another computer's address (the computer)"] = misaddressed.message;
  check(
    "The connector refuses with 401 and the challenge a token for another computer's address, an expired one, a forged one and another issuer's",
    refusals
  );
  check(
    "A token for the right address but another account's sub is stopped at Deus Cloud (the computer is not on that account, before any dial, initialize included); carried to the computer anyway, the computer refuses it itself, as it does a misaddressed or expired one",
    {
      cloud: bobAtCloud.message,
      computer: bobAtComputer.message,
      misaddressed: misaddressed.message,
      expired: expiredAtComputer.message,
    }
  );

  // ---- 9. The computer offline, then back ----
  await stack.stop(host);
  const offlineStarted = Date.now();
  // Deus Cloud cannot ask the computer, so it answers the call itself, as a
  // tool result marked as an error: the words are what the model reads.
  const offline = await chatgpt.call("list_sessions");
  const offlineMs = Date.now() - offlineStarted;
  assert.equal(offline.isError, true, JSON.stringify(offline));
  assert.equal(offline.text, "Studio Mac is offline or asleep. Nothing was done.");
  const offlineRaw = await rawCall(url, chatgpt.token, "list_sessions");
  assert.deepEqual(offlineRaw.json, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [{ type: "text", text: "Studio Mac is offline or asleep. Nothing was done." }],
    },
  });
  assert(offlineMs < 5_000, `answered in ${offlineMs}ms`);
  // initialize and tools/list: Deus Cloud gives back the computer's last answers
  // to them (with the request's own id), so a client can still connect and load
  // the tools; every call then says why nothing happened.
  const initializeBody = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "x", version: "1" },
    },
  });
  const initializeStarted = Date.now();
  const offlineInitialize = await rawMcp(url, { token: chatgpt.token, body: initializeBody(7) });
  const offlineInitializeMs = Date.now() - initializeStarted;
  assert.equal(offlineInitialize.status, 200, offlineInitialize.text);
  assert.equal(offlineInitialize.json?.id, 7);
  assert.equal(offlineInitialize.json?.result?.serverInfo?.title, "Deus on Studio Mac");
  assert(offlineInitializeMs < 5_000, `initialize answered in ${offlineInitializeMs}ms`);
  const offlineTools = await rawMcp(url, {
    token: chatgpt.token,
    body: { jsonrpc: "2.0", id: 8, method: "tools/list" },
  });
  assert.equal(offlineTools.json?.id, 8);
  assert.deepEqual(
    offlineTools.json?.result?.tools?.map((t) => t.name),
    tools.map((t) => t.name)
  );
  // A client that never connected before (the second assistant's own token): it
  // connects, lists the same tools, and its call reads the offline words.
  const sdkStarted = Date.now();
  const sdkOffline = await connectWithToken(url, claude.token);
  const sdkOfflineMs = Date.now() - sdkStarted;
  assert(sdkOffline.client, `connect while offline: ${sdkOffline.error}`);
  assert.equal(sdkOffline.client.getServerVersion()?.title, "Deus on Studio Mac");
  const { tools: offlineListed } = await sdkOffline.client.listTools();
  assert.deepEqual(
    offlineListed.map((t) => t.name),
    tools.map((t) => t.name)
  );
  const offlineByNew = await sdkOffline.client.callTool({ name: "list_sessions", arguments: {} });
  assert.equal(offlineByNew.isError, true);
  assert.equal(offlineByNew.content[0].text, "Studio Mac is offline or asleep. Nothing was done.");
  await sdkOffline.client.close();
  assert(sdkOfflineMs < 5_000, `the SDK's connect took ${sdkOfflineMs}ms`);
  check(
    `The computer offline: Deus Cloud answers initialize (${offlineInitializeMs}ms) and tools/list from the computer's last answers with the request's own id; a new client connects in ${sdkOfflineMs}ms, lists the same ten tools, and its tool call is a tool result with the offline words`,
    {
      initialize: offlineInitialize.json?.result?.serverInfo,
      tools: offlineListed.map((t) => t.name),
      call: offlineByNew.content[0].text,
    }
  );

  // A computer on the account that has never been reached: nothing remembered,
  // so initialize is refused as before.
  const spareResponse = await fetch(`${cloud.base}/me/machines`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessions.aliceDesktop}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Spare Mac", secret: "s".repeat(43) }),
  });
  assert.equal(spareResponse.status, 201, await spareResponse.clone().text());
  const spare = (await spareResponse.json()).machine;
  const spareUrl = `${cloud.base}/mcp/${spare.id}`;
  const spareToken = await issuer.mint({
    sub: "user_alice",
    resource: spareUrl,
    client: chatgpt.clientId,
  });
  const spareInitialize = await rawMcp(spareUrl, { token: spareToken, body: initializeBody(9) });
  // The relay has never seen this computer host, so it refuses the socket.
  assert.equal(spareInitialize.json?.id, 9);
  assert.equal(spareInitialize.json?.result, undefined, "nothing remembered");
  assert.equal(spareInitialize.json?.error?.code, -32001);
  assert.match(spareInitialize.json?.error?.message, /^Spare Mac .*Nothing was done\.$/);
  const spareTools = await rawMcp(spareUrl, {
    token: spareToken,
    body: { jsonrpc: "2.0", id: 10, method: "tools/list" },
  });
  assert.equal(spareTools.json?.error?.code, -32001);
  const spareSdk = await connectWithToken(spareUrl, spareToken);
  assert.equal(spareSdk.client, null, "nothing remembered: connect fails");
  assert.match(spareSdk.error, /Spare Mac .*Nothing was done\./);
  check(
    "A computer on the account that was never reached has nothing remembered: initialize and tools/list are refused in words naming it (the relay refuses a computer that never hosted), and the SDK's connect fails with them",
    { initialize: spareInitialize.json, sdkError: spareSdk.error }
  );
  host = await startHost();
  await signIn();
  assert.equal(await connected(), machineId);
  mac = await openWindow();
  const back = await chatgpt.call("list_sessions");
  assert.equal(back.isError, false, back.text);
  assert.match(back.text, /voyager/);
  assert.equal((await listed()).find((a) => a.clientId === chatgpt.clientId).access, "operate");
  const reconnected = await connectWithToken(url, chatgpt.token);
  assert(reconnected.client, reconnected.error);
  await reconnected.client.close();
  check(
    `The computer offline: a tool call is answered in ${offlineMs}ms as a tool result marked as an error, in words that say so; after it comes back the stored approval still works, a new connection included`,
    { offline: offline.text, offlineMs }
  );

  // ---- 10. Deny, allow again, remove ----
  await mac.mutate("setAssistantAccess", { clientId: chatgpt.clientId, access: "denied" });
  const denied = await chatgpt.call("list_sessions");
  assert.equal(denied.isError, true);
  assert.match(denied.text, /This assistant was denied on this computer\./);
  // Refused at admission, before any MCP: Deus Cloud answers with a tool result marked as an error.
  assert.equal(
    denied.text,
    "Studio Mac refused this assistant: This assistant was denied on this computer."
  );
  const deniedAgain = await chatgpt.call("read_session", { session: "voyager" });
  assert.match(deniedAgain.text, /This assistant was denied on this computer\./);
  assistants = await listed();
  assert.equal(assistants.find((a) => a.clientId === chatgpt.clientId).access, "denied");
  await mac.mutate("setAssistantAccess", { clientId: chatgpt.clientId, access: "operate" });
  const allowedAgain = await chatgpt.call("list_sessions");
  assert.equal(allowedAgain.isError, false, allowedAgain.text);
  check(
    "Deny: the next calls are refused at admission with the denied sentence and the assistant stays listed as denied; allowed again, it works",
    { denied: denied.text, listed: assistants.find((a) => a.clientId === chatgpt.clientId) }
  );

  await mac.mutate("removeAssistant", { clientId: chatgpt.clientId });
  assert(!(await listed()).some((a) => a.clientId === chatgpt.clientId), "removed from the list");
  const removed = await chatgpt.call("list_sessions");
  assert.equal(removed.text, NOT_ALLOWED_YET);
  assistants = await listed();
  assert.equal(assistants.find((a) => a.clientId === chatgpt.clientId).access, "pending");
  check(
    "Removing the assistant on the computer takes effect on its next call: it is a first contact again, pending",
    { next: removed.text, assistants }
  );

  // ---- 11. A computer with projects and no session ----
  await mac.mutate("setAssistantAccess", { clientId: chatgpt.clientId, access: "operate" });
  for (const w of (await mac.request("workspaces")).flatMap((g) => g.workspaces)) {
    if (w.kind !== "cloud") await mac.mutate("archiveWorkspace", { workspaceId: w.id });
  }
  const empty = await chatgpt.call("list_sessions");
  assert.equal(empty.isError, false, empty.text);
  assert.match(empty.text, /^no sessions\. Projects: /);
  assert.match(empty.text, /"Empty shop"/);
  assert.match(empty.text, /"Remote test"/);
  assert.match(empty.text, /start_session\(project: /);
  check(
    "With no session left, list_sessions says so and names the computer's projects, with the start_session hint",
    { empty: empty.text }
  );

  // ---- 12. The computer removed from the account ----
  // Its record goes, and with it what Deus Cloud remembered: offline or not, the
  // address now answers that the computer is not on the account.
  const removedMachine = await fetch(`${cloud.base}/me/machines/${machineId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessions.aliceDesktop}` },
  });
  assert.equal(removedMachine.status, 200);
  await stack.stop(host);
  const forgotten = await rawMcp(url, { token: chatgpt.token, body: initializeBody(11) });
  assert.equal(forgotten.json?.id, 11);
  assert.equal(forgotten.json?.result, undefined, "no remembered answer");
  assert.match(forgotten.json?.error?.message, /not on the Deus account you signed in with/);
  const forgottenTools = await rawMcp(url, {
    token: chatgpt.token,
    body: { jsonrpc: "2.0", id: 12, method: "tools/list" },
  });
  assert.equal(forgottenTools.json?.result, undefined, "no remembered tool list");
  check(
    "Removing the computer from the account forgets what was remembered: with the computer away, initialize and tools/list are refused (not on the account), not answered from memory",
    { initialize: forgotten.json, tools: forgottenTools.json }
  );

  await Promise.all([chatgpt.close(), claude.close()]);
  report.issuerRequests = issuer.requests;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  windows.forEach((w) => w.close());
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  await stack.close();
  await issuer.close();
}
