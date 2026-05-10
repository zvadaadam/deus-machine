import type { RelayedHttpRequest, RelayedHttpResponse } from "@shared/types/relay";
import { validateDeviceToken } from "./remote-auth.service";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function handleRelayedHttpRequest(
  request: RelayedHttpRequest
): Promise<RelayedHttpResponse> {
  if (!request.deviceToken || !validateDeviceToken(request.deviceToken)) {
    return textResponse(401, "Unauthorized");
  }

  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    return textResponse(400, "Invalid port");
  }

  if (!request.path.startsWith("/")) {
    return textResponse(400, "Invalid path");
  }

  const url = new URL(`http://127.0.0.1:${request.port}${request.path}`);
  if (request.query) {
    url.search = request.query;
  }

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: buildForwardHeaders(request.headers),
      body:
        request.method === "GET" || request.method === "HEAD" || !request.bodyBase64
          ? undefined
          : Buffer.from(request.bodyBase64, "base64"),
      redirect: "manual",
    });

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      return textResponse(502, "Response body too large");
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersToObject(response.headers),
      bodyBase64: Buffer.from(body).toString("base64"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    return textResponse(502, `Local server request failed: ${message}`);
  }
}

function buildForwardHeaders(headers: Record<string, string>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "accept-encoding") continue;
    out.set(key, value);
  }
  out.set("accept-encoding", "identity");
  out.set("host", "localhost");
  return out;
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "content-encoding") continue;
    out[lower] = value;
  }
  return out;
}

function textResponse(status: number, body: string): RelayedHttpResponse {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    bodyBase64: Buffer.from(body, "utf8").toString("base64"),
  };
}
