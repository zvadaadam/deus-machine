// A scripted Deus platform for the cloud journeys: a real HTTP + WebSocket server on
// loopback. It mints session tokens, names the account's organizations and lists their
// sessions, accepts metadata, and holds each session's socket. With `orgs`, each
// organization has its own key and sessions, and a key-authenticated request for a
// session is refused unless it carries that session's organization's key. Every frame it sends is
// checked against the platform's own contract (`WebSocketEventSchema`), so it can only
// say what the real platform may say. Requests it does not serve are answered 404 and
// recorded in `unserved`, for the journey to compare with its allow-list.
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { WebSocketEventSchema } from "@deus-hq/api";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(what, read, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

/** A finished (or still streaming) text part, as the platform stores it. */
export const textPart = (sessionId, id, messageId, text, state = "done") => ({
  type: "text",
  id,
  sessionId,
  messageId,
  text,
  state,
});

/** A frame the platform may send: refused here if its contract does not allow it. */
export function wire(frame) {
  const parsed = WebSocketEventSchema.safeParse(frame);
  assert.ok(
    parsed.success,
    `fake platform frame breaks the contract: ${JSON.stringify(frame)} ${parsed.error}`
  );
  return JSON.stringify(frame);
}

/**
 * @param {object} options
 * @param {string} options.bearer        the Deus Cloud session `/dashboard` routes accept
 * @param {string[]} options.sessions    the platform session ids it knows
 * @param {(sessionId: string) => object} options.snapshot  the `session.snapshot` sent on connect
 * @param {string} [options.org]         the account's organization, served as the dashboard lists it
 * @param {string} [options.orgName]     its name
 * @param {() => object[]} [options.listSessions]  with `org`, serves its session list
 * @param {{ id: string, name: string, key?: string, sessions: string[], listSessions?: () => object[], automations?: object[], accessibleRepos?: string[] }[]} [options.orgs]
 *   several organizations instead of `org`: each with the API key that belongs to it, the
 *   platform sessions in it, with `listSessions` the session list the dashboard serves,
 *   with `automations` its automations (wire summaries), listed on the dashboard, and with
 *   `accessibleRepos` the `owner/name` of each repository its GitHub App reaches
 * @param {Record<string, { defaultBranch: string, branches: string[], token?: string }>} [options.github]
 *   a scripted GitHub REST API under `/github` (point `DEUS_GITHUB_API_URL` at
 *   `${url}/github`): each repository's default branch and branches, paged as GitHub
 *   pages them. With `token`, only a request carrying it is answered (a private one).
 */
export async function startPlatform({
  bearer,
  sessions = [],
  snapshot,
  org,
  orgName = "Smoke",
  listSessions,
  orgs,
  github = {},
}) {
  const platform = {
    url: "",
    /** Every request but CORS preflights, as `METHOD /path`. */
    requests: [],
    /** Requests answered 404, as `METHOD /path`. */
    unserved: [],
    /** Every session socket: `{ session, ws, url, open }`. */
    sockets: [],
    /** Every command received: `{ session, command }`. */
    received: [],
    /** Every key-authenticated request: `{ route, session, key }` (the bearer it carried). */
    keyed: [],
    /** Every request outside `/dashboard`, with the bearer it carried: `{ route, key, body }`. */
    authorized: [],
    /** Every request to the scripted GitHub: `{ route, query, key }`. */
    githubRequests: [],
    tokens: 0,
    socketsFor: (session) => platform.sockets.filter((link) => link.session === session),
    commands: (session) =>
      platform.received.filter((c) => c.session === session).map((c) => c.command),
    live: (session) => platform.sockets.findLast((link) => link.session === session && link.open),
    send: (session, frame) => platform.live(session).ws.send(wire(frame)),
  };
  const accountOrgs = orgs ?? (org ? [{ id: org, name: orgName }] : []);
  const orgOfSession = (id) => orgs?.find((o) => o.sessions.includes(id));
  const known = (id) => sessions.includes(id) || Boolean(orgOfSession(id));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://platform");
    let body = "";
    for await (const chunk of request) body += chunk;
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "*",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      return response.end();
    }
    const route = `${request.method} ${url.pathname}`;
    platform.requests.push(route);
    const json = (data, status = 200) => {
      response.writeHead(status, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    const parts = url.pathname.split("/").slice(1);
    if (parts[0] !== "dashboard") {
      const key = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      platform.authorized.push({ route, key, body });
    }
    // The scripted GitHub: a repository, and its branches a page at a time.
    if (parts[0] === "github" && parts[1] === "repos" && request.method === "GET") {
      const slug = `${parts[2]}/${parts[3]}`;
      const key = String(request.headers.authorization ?? "").replace(/^Bearer /, "") || null;
      platform.githubRequests.push({ route, query: url.search, key });
      const repository = github[slug];
      if (!repository || (repository.token && key !== repository.token)) {
        return json({ message: "Not Found" }, 404);
      }
      if (parts.length === 4) {
        return json({ full_name: slug, default_branch: repository.defaultBranch });
      }
      if (parts[4] === "branches" && parts.length === 5) {
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const names = repository.branches.slice((page - 1) * perPage, page * perPage);
        return json(names.map((name) => ({ name, protected: false })));
      }
    }
    if (parts[0] === "dashboard" && request.headers.authorization !== `Bearer ${bearer}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const [a, b, c, d] = parts;
    if (
      request.method === "POST" &&
      a === "dashboard" &&
      b === "sessions" &&
      known(c) &&
      d === "token"
    ) {
      platform.tokens++;
      return json({ token: `session-token-${platform.tokens}`, expires_in: 3600 });
    }
    // The account's organizations, in the shape of AGNT's `routes/dashboard/orgs.ts`.
    if (accountOrgs.length > 0 && route === "GET /dashboard/orgs") {
      return json({
        account_id: "acc_smoke",
        items: accountOrgs.map((o) => ({
          id: o.id,
          name: o.name,
          role: "owner",
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
        })),
      });
    }
    if (org && listSessions && route === `GET /dashboard/orgs/${org}/sessions`) {
      return json({ items: listSessions() });
    }
    // Deus Cloud's GitHub App mint, when the journey points DEUS_CLOUD_URL here: a
    // token for any organization that has `githubToken`, so nothing asks GitHub itself.
    const minting = orgs?.find(
      (o) => o.githubToken && route === `POST /orgs/${o.id}/github/installation-token`
    );
    if (minting) return json({ token: minting.githubToken, expires_at: null });
    // The repositories an organization's GitHub App reaches (Deus Cloud, the person's session).
    const reaching = orgs?.find(
      (o) => o.accessibleRepos && route === `GET /orgs/${o.id}/github/accessible-repos`
    );
    if (reaching) {
      if (request.headers.authorization !== `Bearer ${bearer}`) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ repos: reaching.accessibleRepos });
    }
    const listed = orgs?.find(
      (o) => o.listSessions && route === `GET /dashboard/orgs/${o.id}/sessions`
    );
    if (listed) return json({ items: listed.listSessions() });
    // An organization's automations, as the dashboard lists them (one page).
    const scheduled = orgs?.find(
      (o) => o.automations && route === `GET /dashboard/orgs/${o.id}/automations`
    );
    if (scheduled) return json({ items: scheduled.automations, has_more: false });
    if (request.method === "PATCH" && a === "sessions" && known(b) && c === "metadata") {
      const key = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      platform.keyed.push({ route, session: b, key });
      // An organization's key acts in that organization only.
      if (orgs && orgOfSession(b)?.key !== key) return json({ error: "forbidden" }, 403);
      return json({ ok: true });
    }
    platform.unserved.push(route);
    return json({ error: "not found" }, 404);
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://platform");
    const session = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/)?.[1];
    if (!session || !known(session)) {
      platform.unserved.push(`WS ${url.pathname}`);
      return socket.destroy();
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const link = { session, ws, url, open: true };
      platform.sockets.push(link);
      ws.on("close", () => (link.open = false));
      ws.on("message", (raw) => {
        const data = String(raw);
        if (data === "ping") return void ws.send("pong");
        platform.received.push({ session, command: JSON.parse(data) });
      });
      ws.send(wire(snapshot(session)));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  platform.url = `http://127.0.0.1:${server.address().port}`;
  platform.close = () => {
    for (const link of platform.sockets) link.ws.terminate();
    sockets.close();
    server.closeAllConnections();
    server.close();
  };
  return platform;
}

/**
 * The turn both journeys script after the prompt leaves: the platform admits it,
 * echoes the prompt (the engine names the echo `echo-<turnId>`, part
 * `echo-<turnId>-0`; the composer's bubble is built to those ids), streams a reply,
 * asks a question, and ends.
 */
export function scriptedTurn(platform, session, sent) {
  const turnId = sent.turnId;
  const echo = `echo-${turnId}`;
  const echoPart = `echo-${turnId}-0`;
  const reply = "Hello from the scripted platform, all of it.";
  const now = () => Date.now();
  const send = (frame) => platform.send(session, frame);
  const at = { sessionId: session, turnId };
  const delta = (text) =>
    send({
      type: "message.part.delta",
      ...at,
      messageId: "m_agent_2",
      outputIndex: 4,
      partIndex: 0,
      partId: "p_agent_2",
      delta: { type: "text", text },
      timestamp: now(),
    });
  return {
    reply,
    question: "Which colour should the smoke use?",
    /** Admits the turn, echoes the prompt and types the reply's first half. */
    start() {
      send({
        type: "message.accepted",
        ...at,
        messageId: sent.messageId,
        queued: false,
        deduplicated: false,
      });
      send({ type: "turn.started", ...at, timestamp: now() });
      send({
        type: "message.started",
        ...at,
        messageId: echo,
        messageIndex: 2,
        outputIndex: 3,
        role: "user",
        timestamp: now(),
      });
      send({
        type: "message.part",
        ...at,
        messageId: echo,
        outputIndex: 3,
        partIndex: 0,
        part: textPart(session, echoPart, echo, sent.text),
        timestamp: now(),
      });
      send({
        type: "message.started",
        ...at,
        messageId: "m_agent_2",
        messageIndex: 3,
        outputIndex: 4,
        role: "assistant",
        timestamp: now(),
      });
      send({
        type: "message.part",
        ...at,
        messageId: "m_agent_2",
        outputIndex: 4,
        partIndex: 0,
        part: textPart(session, "p_agent_2", "m_agent_2", "", "streaming"),
        timestamp: now(),
      });
      delta("Hello from ");
      delta("the scripted ");
    },
    ask() {
      send({
        type: "elicitation.requested",
        ...at,
        requestId: "ask_1",
        mode: "question",
        message: "Which colour?",
        questions: [
          {
            id: "q1",
            question: "Which colour should the smoke use?",
            header: "Colour",
            options: [
              { label: "Blue", description: "The calm one" },
              { label: "Red", description: "The loud one" },
            ],
          },
        ],
        timestamp: now(),
      });
    },
    resolve(outcome) {
      send({ type: "elicitation.resolved", ...at, requestId: "ask_1", outcome, timestamp: now() });
    },
    /** Types the rest of the reply and ends its message; `end()` ends the turn. */
    finishReply() {
      delta("platform, all of it.");
      send({
        type: "message.part",
        ...at,
        messageId: "m_agent_2",
        outputIndex: 4,
        partIndex: 0,
        part: textPart(session, "p_agent_2", "m_agent_2", reply),
        timestamp: now(),
      });
      send({ type: "message.ended", ...at, messageId: "m_agent_2", timestamp: now() });
    },
    end() {
      send({ type: "turn.ended", ...at, stopReason: "end_turn", timestamp: now() });
    },
    /** The turn's two rows, as the platform's history holds them afterwards. */
    rows() {
      return [
        {
          id: echo,
          messageIndex: 2,
          sessionId: session,
          turnId,
          outputIndex: 3,
          role: "user",
          createdAt: now(),
          parts: [textPart(session, echoPart, echo, sent.text)],
        },
        {
          id: "m_agent_2",
          messageIndex: 3,
          sessionId: session,
          turnId,
          outputIndex: 4,
          role: "assistant",
          createdAt: now(),
          parts: [textPart(session, "p_agent_2", "m_agent_2", reply)],
        },
      ];
    },
  };
}
