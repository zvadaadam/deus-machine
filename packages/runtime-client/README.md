# @deus/runtime-client

Private Bun workspace package for the `q:` application-data protocol. The web and
Electron renderer consume the same client. It is source TypeScript, resolved by
the workspace's bundler; it is not a published SDK.

| Entry                                        | Owns                                                                                                       | Dependencies                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `@deus/runtime-client`                       | Connection lifecycle, authentication handshake, reconnect, pending requests, subscription sharing, streams | `ts-pattern`; injected socket                     |
| `@deus/runtime-client/query`                 | One projection per subscription and query key, cache invalidation on disconnect, cache cleanup on disposal | Core client; optional `@tanstack/query-core` peer |
| `apps/web/src/platform/ws/runtime-client.ts` | The Deus contract (`call`, `follow` over `shared/api`), cache defaults, cache-to-runtime lookup            | App code                                          |

Host selection, credential storage, relay URLs, React hooks, routing and chat
projections stay in the app. The backend query engine and the contract
(`shared/api`) also stay there: this package carries names and values, and knows none of them. This package does not replace `@zvada/agent-server/client`, which
speaks the separate agent-execution protocol.

## Core client

Supply a socket factory bound to one host and authorization grant. The client
does not access storage, browser globals, Electron or environment variables.

```ts
import { RuntimeClient } from "@deus/runtime-client";

const client = new RuntimeClient(
  { host: hostId, account: accountId, grant: grantId },
  { open: () => new WebSocket(endpoint) }
);
const stop = client.subscribe("workspaces", {}, (snapshot) => render(snapshot));
await client.connect();
const workspaces = await client.sendRequest("workspaces");

stop();
client.dispose();
```

`grant` identifies authorization; it is not a bearer token. For an authenticated
relay, provide `authenticate: () => ({ type: "authenticate", token })` using the token
captured for this runtime. `open` must return a new connecting socket; the client
installs its listeners and sends authentication on the socket's open event.
`connect()` resolves after `connected` (direct) or `authenticated` (relay).

The transport sends a correlated `{ type: "ping", id }` every 30 seconds and
expects `{ type: "pong", id }` within 10 seconds. This checks both directions,
including the backend leg of a relay connection. Missing the reply closes the
socket and starts reconnect with exponential backoff and jitter. Cached data
remains visible but stale; pending writes have an unknown outcome. Configure
`heartbeatIntervalMs` / `heartbeatTimeoutMs` for another transport, or set the
interval to `0` for a legacy host without probe support. Ship the backend's probe
handler with the new client.

### Streams

```ts
const stop = client.listen("sessionEvents", { sessionId }, (event) => fold(event), {
  onReset: () => readAgain(),
});
```

`listen` follows a stream of events narrowed by a filter. Only what was asked
for arrives, once and in order, and listeners of the same stream and filter
share one subscription on the wire. The subscription is restored on every
reconnect. Where the host numbers a stream's events (`seq`), it says where the
stream stands when the subscription is made (`q:subscribed`); on a return the
client names the last number it has and the host sends what followed. When
that is not possible (the stream is not numbered, or the host no longer holds
that far back and answers `q:reset`), `onReset` runs: something may have been
missed, so the consumer reads its state again. It does not run on the first
subscription. A live read that answers with a `cursor` (in its snapshot or a
delta) is resumed the same way.

`publishLocal(stream, scope, data)` delivers an event to this client's own
listeners, for a source that lives in the client (a channel the browser holds
itself). A subscription the host refuses is dropped and reported to
`onRefused`; it is not retried.

Create a new runtime when host, account or grant changes. Disposal closes the
socket, rejects pending work and stops subscriptions. Keep the originating
runtime across asynchronous operations, so late results cannot enter another
host's state. Revocation by the host (`auth_failed`, close `4001`/`4003`) ends
the runtime and calls `onAuthFailure`. `open` may also refuse for good by
rejecting with a `RuntimeError` of kind `rejected` (Deus does this when Deus
Cloud says the account cannot reach the computer): the runtime ends as
`revoked` without retrying and without `onAuthFailure`, since the host's grant
was never tried. Any other `open` failure reconnects with backoff.
An authentication timeout is transient: the relay closes with `1013` so the
client retries with the same grant. Invalid or revoked credentials still end
the runtime. A replacement relay host closes existing viewers with `1012` so
their new connections authenticate before restoring subscriptions.

## Query cache adapter

```ts
import { QueryClient } from "@tanstack/query-core";
import { QueryRuntimeClient } from "@deus/runtime-client/query";

const client = new QueryRuntimeClient(identity, {
  open: () => new WebSocket(endpoint),
  queryClient: new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  }),
});
const stop = client.retainQuery("sessions", { workspaceId }, ["sessions", workspaceId]);
await client.connect();
```

Pass a dedicated cache to each runtime; the adapter owns it and clears it on
disposal or revocation. The app chooses cache defaults and provides custom delta
mergers for projections other than flat lists keyed by `id`. Equal resource and
parameter sets share one wire subscription. Bindings with the same resource,
parameters and cache key also share one projection, so multiple components do
not apply a delta more than once. (Two different subscriptions written into one
cache key would each merge into it; give each subscription its own key.)

Snapshots containing `null` clear absent resources. An application can supply
`acceptSnapshot(resource, data)` to exclude acknowledgment-only snapshots; Deus
uses this for the messages resource's null acknowledgment. That exception does
not apply to a deleted session or other resource.

Reconnect restores subscriptions, snapshots and streams. It never resends a
write. A write whose acknowledgment is lost rejects with a `RuntimeError`
whose `kind` is `unknown-outcome`: the server may already have committed it.
Higher layers must reconcile state instead of automatically retrying that write.
The package provides neither durable write replay nor relay encryption.

## Checks

From the repository root:

```sh
bun run test:runtime-client
bun run typecheck:runtime-client
```

Tests run in Node without app aliases. The core suite rejects imports of the
optional cache peer; adapter tests cover sharing, reconnect, uncertain writes,
runtime isolation and disposal. App binding tests separately cover Deus's cache
defaults. Root `test`, `typecheck` and CI include the package checks.

`bun run test:e2e:runtime-client` boots the actual app with an isolated SQLite
database and tests browser latency, bandwidth limits, outages and silent failures.
`bun run test:e2e:remote-access` runs the account-bound relay end to end: Deus
Cloud, the relay Worker, Deus backends and the web app, including host and relay
restarts, a Deus Cloud outage, pairing and device revocation. Setup and evidence
paths are documented in `test/e2e/README.md`.
