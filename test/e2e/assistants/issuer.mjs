// A stand-in for the Deus sign-in (WorkOS AuthKit), the only part of the
// assistants stack that is not the real thing. It serves what an MCP client
// finds from a resource's metadata alone: authorization server metadata,
// dynamic client registration, an authorize endpoint with PKCE (S256) whose
// "sign-in page" consents at once as the account chosen with `signInAs`, the
// token endpoint (code and refresh), and the JWKS. Access tokens have
// AuthKit's shape: RS256, `iss`, `aud` = the resource the client asked for
// (RFC 8707), `sub` = the account, `client_id`, `org_id` when the sign-in
// chose an organization, `exp`.
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** WorkOS client ids look like `client_01J…`: a prefix and 26 Crockford characters. */
function clientId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let id = "client_01";
  for (let i = 0; i < 24; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

/**
 * `accessSeconds` is the lifetime of the access tokens it issues;
 * `E2E_ISSUER_ACCESS_SECONDS` overrides it (short lifetimes test renewal), and
 * `setAccessSeconds` changes it while running (refresh tokens stay valid).
 */
/**
 * `port` and `publicUrl` are for a test with a hosted assistant over a public
 * tunnel: listen on that port and call itself by that address.
 */
export async function startIssuer({ accessSeconds = 3600, port = 0, publicUrl } = {}) {
  if (Number(process.env.E2E_ISSUER_ACCESS_SECONDS) > 0) {
    accessSeconds = Number(process.env.E2E_ISSUER_ACCESS_SECONDS);
  }
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = `e2e-issuer-${Date.now()}`;
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }] };
  const clients = new Map();
  const codes = new Map();
  const refreshes = new Map();
  /** Every request, in order: what an MCP client did to sign in. */
  const requests = [];
  let account = { sub: "user_unknown", org: null };
  let url;

  /** A correctly signed access token with these claims (`aud` is the resource). */
  async function mint({
    sub = account.sub,
    org = account.org,
    resource,
    client = "client_01E2ETESTASSISTANT000000",
    seconds = accessSeconds,
    issuer = url,
    key = privateKey,
  }) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ client_id: client, ...(org ? { org_id: org } : {}), sid: randomUUID() })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + seconds)
      .setJti(randomUUID())
      .sign(key);
  }

  const server = createServer(async (req, res) => {
    const at = new URL(req.url, url);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(`${req.method} ${at.pathname}`);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const error = (status, code, description) =>
      json(status, { error: code, ...(description ? { error_description: description } : {}) });

    if (
      at.pathname === "/.well-known/oauth-authorization-server" ||
      at.pathname === "/.well-known/openid-configuration"
    ) {
      return json(200, {
        issuer: url,
        authorization_endpoint: `${url}/oauth2/authorize`,
        token_endpoint: `${url}/oauth2/token`,
        registration_endpoint: `${url}/oauth2/register`,
        jwks_uri: `${url}/oauth2/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
      });
    }
    if (at.pathname === "/oauth2/jwks") return json(200, jwks);

    if (at.pathname === "/oauth2/register" && req.method === "POST") {
      let meta;
      try {
        meta = JSON.parse(raw);
      } catch {
        return error(400, "invalid_client_metadata");
      }
      if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
        return error(400, "invalid_redirect_uri");
      }
      const client = {
        ...meta,
        client_id: clientId(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
      };
      clients.set(client.client_id, client);
      return json(201, client);
    }

    if (at.pathname === "/oauth2/authorize") {
      const q = Object.fromEntries(at.searchParams);
      const client = clients.get(q.client_id);
      if (!client || !client.redirect_uris.includes(q.redirect_uri)) {
        return error(400, "invalid_client");
      }
      if (q.response_type !== "code") return error(400, "unsupported_response_type");
      if (q.code_challenge_method !== "S256" || !q.code_challenge) {
        return error(400, "invalid_request", "PKCE with S256 is required");
      }
      if (!q.resource) return error(400, "invalid_target", "resource is required");
      // The person signs in to Deus here and agrees; the stand-in always does.
      const code = randomUUID();
      codes.set(code, {
        client: q.client_id,
        redirectUri: q.redirect_uri,
        challenge: q.code_challenge,
        resource: q.resource,
        ...account,
      });
      const back = new URL(q.redirect_uri);
      back.searchParams.set("code", code);
      if (q.state) back.searchParams.set("state", q.state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (at.pathname === "/oauth2/token" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (form.grant_type === "authorization_code") {
        const entry = codes.get(form.code);
        codes.delete(form.code);
        if (!entry || entry.client !== form.client_id || entry.redirectUri !== form.redirect_uri) {
          return error(400, "invalid_grant");
        }
        const verifier = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (verifier !== entry.challenge) return error(400, "invalid_grant", "PKCE check failed");
        if (form.resource && form.resource !== entry.resource) return error(400, "invalid_target");
        const refresh = randomUUID();
        refreshes.set(refresh, entry);
        return json(200, {
          access_token: await mint({ ...entry, client: entry.client }),
          token_type: "Bearer",
          expires_in: accessSeconds,
          refresh_token: refresh,
        });
      }
      if (form.grant_type === "refresh_token") {
        const entry = refreshes.get(form.refresh_token);
        if (!entry || entry.client !== form.client_id) return error(400, "invalid_grant");
        return json(200, {
          access_token: await mint({ ...entry, client: entry.client }),
          token_type: "Bearer",
          expires_in: accessSeconds,
          refresh_token: form.refresh_token,
        });
      }
      return error(400, "unsupported_grant_type");
    }
    error(404, "not_found");
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  url = publicUrl ?? `http://127.0.0.1:${server.address().port}`;

  return {
    get url() {
      return url;
    },
    requests,
    clients,
    /** Who the next sign-in is: an account id, and the organization it chooses (or none). */
    signInAs(sub, org = null) {
      account = { sub, org };
    },
    mint,
    setAccessSeconds(seconds) {
      accessSeconds = seconds;
    },
    /** A key pair of the same kind that the issuer does not publish: for forged tokens. */
    async foreignKey() {
      return (await generateKeyPair("RS256")).privateKey;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
