import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

/**
 * A hosted assistant that is given only the URL. The SDK client meets the 401,
 * reads the resource's metadata, registers itself with the sign-in it names,
 * signs in (the stand-in consents at once) and connects. `trace` records every
 * request it made, in order.
 */
export async function assistantFromUrl(url, { name, redirect }) {
  const store = {};
  const trace = [];
  let code;
  const fetchTraced = async (input, init) => {
    const response = await fetch(input, init);
    const target = new URL(String(input instanceof Request ? input.url : input));
    trace.push(`${init?.method ?? "GET"} ${target.origin}${target.pathname} ${response.status}`);
    return response;
  };
  const provider = {
    get redirectUrl() {
      return redirect;
    },
    get clientMetadata() {
      return {
        client_name: name,
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => store.client,
    saveClientInformation: (client) => {
      store.client = client;
    },
    tokens: () => store.tokens,
    saveTokens: (tokens) => {
      store.tokens = tokens;
    },
    saveCodeVerifier: (verifier) => {
      store.verifier = verifier;
    },
    codeVerifier: () => store.verifier,
    async redirectToAuthorization(authorizationUrl) {
      // The person's browser: the stand-in sign-in answers with the redirect at once.
      const answer = await fetchTraced(authorizationUrl, { redirect: "manual" });
      code = new URL(answer.headers.get("location")).searchParams.get("code");
    },
  };
  const open = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: provider,
      fetch: fetchTraced,
    });
    const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      await transport.finishAuth(code);
      return null;
    }
  };
  const client = (await open()) ?? (await open());
  if (!client) throw new Error(`${name} did not connect after signing in`);
  /**
   * A tool call as the model sees it: its text, and whether it was an error.
   * Also when Deus Cloud answers instead of the computer (offline, refused at
   * admission) the answer is a tool result marked as an error, so a protocol
   * error here is a failure of the test.
   */
  const call = async (tool, args = {}) => {
    const started = Date.now();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: 170_000,
    });
    return {
      text: result.content.map((part) => part.text ?? "").join("\n"),
      isError: Boolean(result.isError),
      ms: Date.now() - started,
    };
  };
  return {
    client,
    call,
    trace,
    get clientId() {
      return store.client?.client_id;
    },
    get token() {
      return store.tokens?.access_token;
    },
    close: () => client.close(),
  };
}

/**
 * The SDK client connecting with a token it already holds: the client, or the
 * error text the client would show (its `connect` failing).
 */
export async function connectWithToken(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "Reconnect", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30_000 });
    return { client, error: null };
  } catch (error) {
    await transport.close().catch(() => {});
    return { client: null, error: String(error?.message ?? error) };
  }
}

/** One raw MCP POST, as any HTTP client could send it. */
export async function rawMcp(url, { token, body, method = "POST", headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(30_000),
    ...(method === "POST"
      ? { body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "tools/list" }) }
      : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON (a plain refusal).
  }
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    text,
    json,
  };
}

/** A `tools/call` over raw HTTP: the text the model would read, and whether it is an error. */
export async function rawCall(url, token, name, args = {}) {
  const answer = await rawMcp(url, {
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const result = answer.json?.result;
  return {
    ...answer,
    isError: Boolean(result?.isError ?? answer.json?.error),
    message: result?.content?.[0]?.text ?? answer.json?.error?.message ?? answer.text,
  };
}
