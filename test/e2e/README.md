# Tests

This directory contains all test files for the Deus application.

## Test Files

### Runtime client network and relay tests

`runtime-client-network.runtime.mjs` starts the real backend and Vite app with an
isolated SQLite database. A desktop browser exercises 700ms latency in each
direction, a 24 KiB/s bandwidth limit, 20 rapid writes, repeated disconnects,
lost and late acknowledgments, missing resources, page reload, and silent
traffic loss with the production 30s + 10s heartbeat deadline; a mobile browser
watches the same data and goes offline (cached reads, refused writes, catching
up). It also checks for duplicate sends, leftover subscriptions, pending
operations and browser errors. Delayed WebSocket frames retain TCP ordering.

```sh
bun run native:node
bunx playwright install chromium
bun run test:e2e:runtime-client
```

The package's faster fault tests run with `bun run test:runtime-client`.

### Starting a workspace, and a start that fails

`workspace-start.runtime.mjs` starts the real backend and Vite app with an
isolated SQLite database and two scratch Git repositories, with no agent engine
(no message can start a turn). A desktop browser and a phone-sized one watch
the same workspaces. It checks, in order:

- A workspace the previous backend was still starting (a row in `initializing`,
  a worktree Git has registered and locked) fails at startup, and the worktree
  and branch are gone.
- A workspace starts on Home and nowhere else: the sidebar's "New workspace"
  row and a project's "+" both open it, the second with that project chosen,
  and nothing opens a dialog.
- A message sent from Home's composer into a project whose branch does not
  exist: the start fails in the transcript, with the reason, the tool's own
  output, Retry and Delete, on both devices; the message is kept, shown as the
  bubble it will be; no folder and no branch are left. The chat's composer is
  there on both devices, the phone's as wide as the screen. Nothing else is offered: no new chat, no Create PR, no
  tools pane, no tab bar on the phone.
- Retry starts the same workspace again: same id and name, each stage reaching
  both devices over the WebSocket, the kept message sent to the chat it opens,
  once, and that chat opening with how the workspace started. While it starts,
  a second message typed on its page is refused with a toast and stays in the
  composer; when the chat opens it is in the chat's composer, which has the
  same x, width and bottom. A workspace that started can be neither retried
  nor deleted.
- An unreachable remote does not stop a start; the chat opens with a warning
  that the workspace may be behind.
- With a remote that hangs, creating a workspace still answers at once and the
  fetch is a stage on screen. A message typed on its page while it starts
  waits as a bubble, and is sent once when it is ready. A phone left on the
  Code tab while a start fails shows the failure.
- Two workspaces started back to back from Home, with a reload of the window
  while both start: each gets its own message, once. One that is still
  starting opens from the sidebar, where its row names the step. The send
  itself is refused (no agent engine), so the message waits in that chat's
  composer and a toast says so; it is not sent again.
- A start that fails while nobody is looking at it toasts; Delete removes it
  and puts its message in Home's composer.
- A workspace that cannot be created (its project is gone) says why, and the
  message is still in Home's composer.
- A message waiting for a workspace whose chat was already spoken to (from
  another window) is not sent: it goes into that chat's composer.

```sh
bun run native:node
bunx playwright install chromium
bun run test:e2e:workspace-start
```

Screenshots and `results.json` land in `.context/workspace-start/`.

### Account-bound remote access (`remote-access/`)

`remote-access/run.mjs` runs the whole remote-access stack on loopback: a
disposable Postgres container migrated with AGNT's migrations, Deus Cloud from
the linked AGNT worktree, the relay Worker, a Deus backend with an isolated
SQLite database, `@deus/runtime-client`, and the real web app in Chromium. Deus
Cloud sessions are signed with the run's own secret in the shape Deus Cloud
issues after WorkOS sign-in; only the WorkOS page is stood in for (its redirect
returns the same `#token=` fragment). No production service or real account is
used.

```sh
bun run native:node
bunx playwright install chromium
AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:remote-access
```

Docker must be running. It checks, in order:

- Turning on remote access registers the Mac under its signed-in account only, and
  only the process holding the backend's spawn token may hand it an account.
- Deus Cloud gives another account nothing; hosting needs the desktop app plus
  the Mac's own secret.
- The relay refuses sockets without a valid, unused ticket for that machine and
  role, and refuses even a correctly signed ticket for another account once a
  machine is pinned. In the real Durable Object runtime, two accounts racing to
  host one unclaimed machine, and one ticket presented twice at once, each admit
  exactly one socket; a ticket that expires in transit is refused.
- One-use pairing approves a device for the relay-verified account.
- Two devices read, subscribe, write and answer heartbeat probes through the relay.
- A slow Deus Cloud (700ms each way) only slows dialing.
- A six-second authentication delay redials with a fresh ticket without revoking.
- An offline Mac keeps viewers connected but blocks writes; new viewers wait;
  pairing is refused with "This computer is offline" on the socket; a restarted
  Mac keeps its machine id and viewers reconnect with the same grants.
- A Deus Cloud outage leaves live connections working; new dials resume after.
- A relay restart keeps the machine's owner; the Mac, its viewers and a viewer
  that dialed during the outage reconnect.
- Signing the Mac into another account cuts the first account off; signing back
  reuses its approvals without a new code.
- Revoking one device ends its access and old grant; the other keeps working.
- Two computers in one account approve their own devices; a grant opens only its
  own computer.
- Direct LAN access still needs pairing, and settings never serve machine secrets.
- Removing a computer from the account keeps it off through a restart and retires
  its relay grants, leaving the account's other computer; turning remote access on
  registers it anew.
- In the browser: scanning the QR while signed out (sign in, approve with the
  link's code, connect, secrets scrubbed from the URL); reload and a new tab
  reconnect without a code; reopening a QR link on an approved browser leaves its
  code unspent; `/connect` signs in from its own page, lists the account's
  computers, and says when Deus Cloud is unreachable until Try again succeeds;
  another account, even holding the
  Mac's code, sees "This computer isn't on your account"; manual approval
  survives a pairing socket that closes with no answer and a double submit,
  pairing once; a QR scanned while the Mac is offline says so, and Try again
  pairs once it is back; sign-in without a redirect loop; the approval page and
  the Mac's dialog both name the computer with the same id fingerprint; the
  Mac's Remote access settings with the QR, which shows a new code once a
  device has paired with the old one.

`REMOTE_ACCESS_E2E_BROWSER_ONLY=1` skips to the browser checks. Logs, Worker
state, the run's databases and `results.json` go to `.context/remote-access/`,
with mobile and desktop screenshots beside them. The relay can still read `q:`
frames: this verifies account admission, not end-to-end encryption.

### Cloud workspaces against a scripted platform (`cloud/`)

Five journeys run cloud workspaces in the real web app, in Chromium, and a sixth
drives the backend alone, against `cloud/platform.mjs`: a local HTTP + WebSocket server on `127.0.0.1` that stands
in for the Deus platform. It mints session tokens (checking the Deus Cloud
bearer), names the account's organizations and lists their sessions, accepts
session metadata, and holds each session's socket (a `session.snapshot` on
connect, `pong` for `ping`, every command recorded). Every frame it sends is
validated against `@deus-hq/api`'s `WebSocketEventSchema` and throws if invalid,
so it can only say what the real platform may say. The journeys script the
platform's side of a turn: the prompt's echo (under the engine's `echo-<turnId>`
ids), a streamed reply, a question, the end of the turn, and dropped sockets.

- `cloud/mac-lane.browser.mjs`, the desktop's lane: a real backend (isolated
  SQLite database with two cloud workspaces) holds the platform's socket, and
  the app follows the backend's streams. It checks the transcript from the
  snapshot; the sandbox address and simulator status on their streams; one
  `message.send` per prompt; the reply shown while it is typed; a second client
  that hovers and then opens the chat mid-reply, and that is reset and reads
  again, shows the reply typed so far once; the question card and its
  `elicitation.respond`; one prompt bubble at the end; the page equal to a fresh
  read of the database; each row once after the platform socket drops; and a
  client opening a chat the backend restored mid-reply sees the part as it
  stands, then the tokens after it.
- `cloud/direct-lane.browser.mjs`, the hosted web's lane (`VITE_CLOUD_DIRECT=1`,
  no backend): the browser lists the platform's sessions, mints a token from
  its web session and holds the socket itself. It checks the sidebar, the
  menu's two organizations (no computer row, "Your computers") and the sidebar
  filtered by the one chosen (a row and ⌃1), the snapshot, the side streams, `message.send`,
  streaming, the question, the session list read again when the turn ends,
  and each row once after a dropped socket.
- `cloud/organizations.runtime.mjs`, several organizations on one Mac (no
  browser): the platform holds two organizations, each with its own key and
  sessions, and refuses an organization-scoped request carrying another one's
  key. The backend, handed one key per organization, connects a workspace in
  each (and one whose row names none) at once; it checks that a second
  organization's key arriving closes nothing, that each session's metadata
  `PATCH` carries its organization's key, that a row without an organization
  takes the one its snapshot names, and the `cloudOrganizations` read.
- `cloud/organizations.browser.mjs`, the location menu with several organizations,
  in the real web app on the Mac lane: Acme and Beta set up on this computer, Gamma
  with no key. It checks the menu's rows (this computer, each organization by name,
  ⌃2/⌃3, Gamma "Not set up" and disabled), that a row and the shortcuts switch the
  header, the check and the sidebar's list; returning to the workspace last selected
  in each organization; opening another organization's workspace moving the window;
  a reply streaming in Acme arriving whole while the window is on Beta (its socket
  untouched); the Home composer's Cloud control from this computer reading "Cloud",
  off, its menu listing the organizations (Gamma "Not set up"), and choosing Beta
  turning it on and naming Beta without moving the sidebar; creating then reaching the
  platform with Beta's key and Beta's GitHub App token only, the row listed in Beta
  only and the window following it there; in Beta, Settings →
  Environments opening on Beta; the automations page listing only the window's
  organization's automations (the platform serves one per organization), naming it,
  and asking the platform for that organization's list; a reload keeping the
  organization; and a sign-out pushed to the open window (one cloud row, "Not signed
  in"). The platform mints GitHub App tokens here, so nothing asks GitHub. A browser on
  the Mac lane has no desktop session, so for Settings the page is given the one the
  desktop app would answer. Creating an automation is covered by the backend and unit
  tests, not here (it needs the model list, provider accounts and environments
  scripted). Menu screenshots go to `.context/shots/org-menu/`, the composer's control
  (off, menu open, on) to `.context/shots/org-composer/`.
- `cloud/cloud-project.browser.mjs`, a project that is not on this computer, on the Mac
  lane, with Acme and Beta set up. The platform also lists each organization's
  reachable GitHub repositories and serves a scripted GitHub API (default branch and
  paged branches; `DEUS_GITHUB_API_URL` points the backend at it), so nothing reaches
  the real GitHub. It checks that "Add project" on this computer offers the local
  actions (a browser has no folder picker, so two of the desktop's three); in Acme the
  composer neither offers nor preselects a project with no GitHub remote, and "Add
  project" opens "Add repository" directly (no menu of one), with no destination,
  Acme's repositories, the one already a project marked "Added", a search, and a
  public-address field whose Add is off for what is not a GitHub repository and reads
  "Open" for one that is already a project; choosing one adds a project with no folder
  (its default branch GitHub's), listed in Acme and not on this computer, and choosing
  it again adds nothing; the composer's picker shows `owner/name`; the branch picker
  lists every GitHub branch as a plain name (no `origin/`: there is no clone), the
  default first, read with Acme's token; the Cloud switch is on and cannot be turned
  off, its tooltip "rocket is not on this Mac"; creating reaches the platform's
  `POST /workspaces` with the repository's URL, the chosen branch and Acme's key; a
  ready cloud workspace's PR target is the branch it started from even while the
  project's stored default is a stale `main`; and Beta's dialog says its GitHub
  access reaches nothing. The journey's local
  repository is `git init`ed by it. Dialog screenshots (list, public URL, empty) go to
  `.context/shots/cloud-project/`.

- `cloud/reach.browser.mjs`, a cloud workspace that no longer behaves as if it were
  on this computer, on the Mac lane, beside a local workspace with a real worktree
  (this computer's experimental browser setting off). In the cloud chat an internet
  link opens in the person's browser and a localhost link in the cloud computer's
  preview (the Browser tab, a frame in a browser) at its port and path, as does the
  card's "Open in External Browser"; this computer's localhost is never opened. ⌘O
  does nothing, the palette has no "Open in Last Editor" or "New Workspace from…",
  the `/` menu lists no skill from this computer (the local workspace's lists its
  worktree's), and the Agent tab says this computer's configuration does not apply.
  A message the platform refuses (`MESSAGE_SEND_FAILED` with
  `PROVIDER_ACCOUNT_RECONNECT_REQUIRED`) is back in the composer, and the card reads
  the platform's sentence without its codes, offers "Open AI Providers" (which opens
  that Settings section) and no "New chat".
  With the window on this computer (⌃1), a turn in the cloud (learnt from the
  platform's snapshot when the backend attaches again) puts a working dot on the
  header's trigger, and its end an unread one there and on the cloud's row.
  Screenshots go to `.context/shots/cloud-reach/`. In a browser the client already
  hides ⌘O and the palette's editor command, so those two checks are the desktop's
  rule seen from a browser; the unit tests hold the rule itself.

Each journey also fails on a page error, and on any request the platform does
not serve beyond the short allow-list at the top of the file (the Mac lane's
backend reads `GET /models`, `GET /workspaces/:id` and `GET /sessions/:id`,
which are answered 404).

```sh
bun run native:node
bunx playwright install chromium
bun run test:e2e:cloud
```

The journeys run under `node --import tsx` (Playwright hangs under Bun); the Mac
lane's backend needs `better-sqlite3` built for Node (`native:node`). Screenshots, the backend log and
the run's database go to `.context/cloud-e2e/`. No sandbox, model, Deus Cloud
or production service is involved, so this does not cover a live sandbox or
the real platform's behaviour, only the app's side of its contract.

### `workspace-location.browser.mjs`

Runs the sidebar header's "where workspaces run" switcher in the real web app
against the real backend. An isolated database holds one local and one cloud
workspace in the same repository; the cloud is the scripted platform from
`cloud/platform.mjs`, so the backend is signed in to Deus Cloud. It checks the
filtered list, the menu (the cloud named by its organization), ⌃1/⌃2, following
a selection opened by URL, restoring the last selection per location, persistence
across a reload, the Home composer's default, and the 390×844 sheet. Then it signs
the backend out the way the desktop app does (empty credentials): a window stored in
the cloud opens on this computer, the cloud row reads "Not signed in" and cannot be
chosen, and signing in again returns the window to the cloud. No sandbox or model call.

```bash
node --import tsx test/e2e/workspace-location.browser.mjs
```

Screenshots of the open menu (local, cloud, mobile, signed out) go to
`.context/workspace-location`.

### Hosted assistants (`assistants/`)

`assistants/run.mjs` runs a hosted assistant's whole path on loopback: the
remote-access stack (`remote-access/stack.mjs`: Postgres, Deus Cloud from the
linked AGNT worktree, the relay Worker, a Deus backend on an isolated SQLite
database) with Deus Cloud's connector configured (`ASSISTANT_ISSUER`,
`RELAY_URL`) and the backend pinned to the same issuer
(`DEUS_ASSISTANT_ISSUER`). Deus Cloud is only a carrier: it checks the token
and that the computer is the account's, then carries each MCP message to the
computer as one `agentMcp` frame, and the computer answers it. The sign-in
service is the only stand-in (`assistants/issuer.mjs`: metadata, dynamic client
registration, PKCE, tokens in AuthKit's shape with `iss`, `aud` = the resource,
`sub`, `client_id`, `org_id`, `exp`). The assistant is the official MCP SDK
client given only the computer's assistant address. The stack's backends run
with no agent engine (`AGENT_ALLOW_AGENTLESS`), the vault's key in a file, not
the login Keychain (`DEUS_VAULT_NO_KEYCHAIN`), and git kept from climbing out of
the run's folder into this checkout (`GIT_CEILING_DIRECTORIES`). No model turn
runs and no agent login is needed: a first task is never delivered, so what is
checked of a start is what it makes and records.

```sh
AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:assistants
```

Docker must be running, and AGNT's `packages/api` and `packages/sdk` built. It
takes about 13 seconds with the Postgres image pulled. It checks, in order:

- The computer shows its address; with no token the connector answers 401 with
  the `resource_metadata` challenge, and the metadata names the sign-in; GET is
  405 and a web page's `Origin` is 403, with no origins configured.
- `initialize` is answered by the computer itself ("Deus on <computer>", with
  instructions), and right after it alone (no `tools/list`) the assistant is
  listed on the computer as pending.
- From the URL alone the SDK client meets the 401, reads the metadata,
  registers, signs in and connects; it is offered exactly the package's ten
  tools (`whoami`, `list_sessions`, `read_session`, `wait_for_sessions`,
  `list_models`, `start_session`, `send_message`, `answer_request`,
  `stop_sessions`, `archive`) and Deus's `read_changes`, `add_project` and
  `send_feedback`, with `readOnlyHint` on the six that read, `destructiveHint`
  on `stop_sessions` and `archive`, and `openWorldHint` on `add_project` and
  `send_feedback`.
- Pending: every call (a read, `whoami`, `send_feedback`, a write) is refused
  with `refused (access)` and the not-allowed-yet sentence, and nothing changes
  (the list is read over the computer's local socket, as its own window).
- The label: Deus Cloud's lookup asks WorkOS at a fixed URL, which cannot be
  stubbed; with no WorkOS key it answers 503 (403 to a web session), and the
  computer shows the fallback (name = client id, `host` null).
- Read only: `whoami` names the assistant and its access; `list_sessions` shows
  every local chat as `workspace:N` with its status, title and who started it
  (a chat another chat started names that chat), and a project with no
  workspace as `(no sessions)`; `read_session` shows a seeded conversation (the
  person's words, the agent's, a tool it ran, a message an assistant sent under
  its name, how each turn ended), the same by reference and by id;
  `wait_for_sessions` on two settled chats answers at once; `read_changes`
  lists the changed file. `archive`, `stop_sessions`, `send_message`,
  `start_session` and `add_project` are refused with the read-only sentence,
  and nothing changes.
- `read_changes` on a file that is not on the changed list (a seeded `.env`) is
  refused, showing none of its content, for a read-only and an operate assistant.
- A chat title with a line break and a fake list line is one JSON-quoted line in
  `list_sessions`.
- `read_session`'s cursor: read again with it, nothing new reads as nothing
  new; after a turn ends, only that turn's messages and a new cursor; a cursor
  that is not this computer's is refused as stale.
- Changing the access closes the assistant's connections: a
  `wait_for_sessions` held on a working chat ends at once, and the model reads
  that the computer ended the connection because the access changed.
- Operate: `archive` archives one workspace by name and another by id (checked
  in the database) and they leave the list (`status: ["archived"]` lists them);
  `stop_sessions` on two idle chats says nothing was running for each; an
  unknown session is refused with the known ones, never an archived or cloud one.
- An archived workspace: a message to its chat and a start in it are refused as
  archived, and archiving it again says it already is.
- A cloud workspace seeded in the computer's database (its own window lists it)
  is not in an assistant's list, is not found by name, `name:1`,
  `project/name`, chat id or workspace id, and cannot be read, waited on, sent
  to, started in, stopped or archived.
- `archive` of one chat: a chat another chat started is put away (`is_hidden`,
  the workspace's current chat moves) and then takes no message; a chat the
  person started, and a workspace's only chat, are refused in words that say
  what to do instead.
- `start_session` refuses, making nothing, an agent that does not run here and
  a project that does not exist. With an explicit agent (Codex) and a title it
  adds a chat to an existing workspace, stored with that agent and title and
  `started_by` naming the assistant, without renaming the workspace;
  `list_sessions` says the assistant started it, and the assistant cannot
  archive it (the person closes it). In a project with no workspace it makes a
  new workspace, set up for real, with `started_by` and the title; the same call
  made twice at once makes one workspace and the second answer is the first's
  result. A start whose setup fails (a project folder that is not a
  repository) leaves the workspace in error, `wait_for_sessions` gives its
  reason, and `archive` removes it.
- The starts-per-minute limit: the eleventh start within a minute is refused
  (`limit_rate`) and makes no chat.
- `wait_for_sessions` on a settled and a working chat: `until: any` answers at
  once and offers the wait on the other; `until: all` waits out its two seconds
  and says which still works. `send_message` to a working chat sends nothing and
  says so.
- A second assistant on the same account waits for its own approval.
- The connector refuses with 401 a token for another computer's address, an
  expired, a forged and another issuer's token. Another account's token for the
  right address is stopped at Deus Cloud (the computer is not on that account);
  carried to the computer anyway with a valid ticket, the computer refuses it
  itself, as it does a misaddressed or expired one.
- The computer offline: a call is answered at once with "… is offline or
  asleep. Nothing was done." as a tool result marked as an error (what a model
  reads). `initialize` and `tools/list` are answered by Deus Cloud from the
  computer's last answers, with the request's own id, so a client that never
  connected before still connects, lists the same tools, and its call reads the
  offline words. A computer on the account that was never reached has nothing
  remembered: `initialize` is refused in words that name it (the relay refuses
  a computer that never hosted) and the SDK's
  `connect` fails with them. After the computer returns the stored approval
  still works, a new connection included.
- Deny: the next calls are refused at admission with "This assistant was denied
  on this computer." (a tool result marked as an error) and it stays listed as
  denied; allowed again, it works.
- Remove: it leaves the list, and its next contact is pending again.
- With every workspace archived, `list_sessions` answers `0 session(s)`, names
  the projects as `(no sessions)` and offers the `start_session` call.
- The computer removed from the account: what Deus Cloud remembered goes with
  it, so with the computer away `initialize` and `tools/list` are refused (not
  on the account) rather than answered from memory.

It prints `SKIP` for what needs the engine's model lists (`list_models`, and a
start naming a model), and `KNOWN FAILURE` for one bug in the engine package:
`start_session`'s own answer for a workspace whose setup failed reads "setup
failed" rather than the reason, because it renders the entry read at the start
(`src/operator/operator.ts`, `ownOutcome`). A message an assistant sends is not
stored here (the engine's echo writes it), so `messages.origin` is the unit
tests' to hold.

Logs, Worker state, the run's database and `results.json` (each check's
evidence: the tools' own words, and what was skipped or is a known failure) go
to `.context/assistants-e2e/`.

### `controls.browser.mjs`

Runs the shared buttons, joined controls, menus, selects and tabs in an isolated
browser. Checks disabled actions, stable press geometry, circular overrides,
keyboard focus/menu behavior, independent tab lifetimes, reduced motion and touch.
No backend or provider credentials are needed.

```bash
bun test/e2e/controls.browser.mjs
```

Light, dark and mobile screenshots are saved under `.context/controls-ui` and
uploaded by CI alongside the workspace usability/layout screenshots.

### `provider-accounts.browser.mjs`

Runs Settings → AI Providers' cloud accounts in an isolated browser against a
fake cloud API: Claude and Codex keys, several Claude subscriptions, replacing
a token or key, defaults, the device sign-in (cancel, add, reconnect, retry),
an identity change, and that no secret stays in the query cache. No backend,
login or provider call is needed.

```bash
bun test/e2e/provider-accounts.browser.mjs
```

### `assistants.browser.mjs`

Runs Settings → Remote access → Assistants in an isolated browser: the real
section, socket and runtime client against a fake host that answers
`assistants`, `relayStatus` (which carries the address), `setAssistantAccess`
and `removeAssistant` over the `q:` wire. Checks the empty state, Add
assistant with the address and copy, the signed-out and remote-access-off states fixed in place, a request
arriving live (one toast per request with Review, none for a denied
assistant, a new one when a removed assistant asks again; the waiting row
first, the Settings sidebar mark), where each assistant signs in (its host, or
"Unverified" and its client id), Allow as Read only, a failed change, Operate,
Deny keeping it listed last as denied, Allow and Remove from its menu, Remove
with its confirmation, no toast for a request already waiting at load, dark
mode and a phone's width. No backend, sign-in or assistant is needed.

```bash
bun test/e2e/assistants.browser.mjs
```

Light, dark and mobile screenshots are saved under `.context/assistants-ui`.

### `model-picker.browser.mjs`

Runs the composer's one picker for agent, model and thinking effort in an
isolated browser, with the engine's own catalog: the trigger's phrase, the
menu's agents, models and levels (marks on the right), the level fitted when
the model changes, a model with no thinking control, the keyboard, another
agent's model in a started chat (a new chat), and a phone's width. No backend
or provider call is needed.

```bash
bun test/e2e/model-picker.browser.mjs
```

### `environment-secrets.browser.mjs`

Runs the real Environment settings components through both the desktop backend
proxy and direct web API against AGNT's authenticated routes and encrypted
Postgres store. Native sign-in, provider metadata and GitHub discovery are fixtures;
public recipe and secret writes, ownership checks, and local repository files are real.
It checks file-versus-saved precedence, local/cloud overrides, file publication without
secrets, malformed-file errors, unsaved-edit guards, all four secret scopes,
organization/account switching, replacement/deletion, mobile layout, and absence of
secret values from query/mutation caches. The agent setup action is checked through
its Local/Cloud request and selected model; this harness does not run an agent turn.

Create and migrate a disposable Postgres database using the linked AGNT checkout,
then run from the Deus worktree:

```bash
AGNT_WORKSPACE=/path/to/agnt \
SECRET_TEST_DATABASE_URL=postgres://agnt:agnt@localhost:5432/secrets_test \
bun test/e2e/environment-secrets.browser.mjs
```

The test starts isolated HTTP/Vite servers and removes its database rows and
temporary session tokens on exit. Screenshots go to `.context/environment-secrets-ui`.
It does not start or restart the user's Electron app. AGNT also provides an opt-in
`tests/integration/environment-secrets.vm.ts` test for real E2B checkout, preparation,
secret injection, an HTTP app, pause/resume, and VM cleanup.

### `project-environment.runtime.mjs`

Runs the full app against a disposable local backend database. It saves the recipe
through Settings, commits it in a temporary Git repository, creates a real worktree,
verifies dotenv copying and the Setup log, then clicks Run and verifies the real
terminal process received the local variable. No provider login or inference is needed.

Start the app from this worktree with Node 22 and isolated state:

```bash
mkdir -p .context/project-environment-app
DATABASE_PATH="$PWD/.context/project-environment-app/deus.db" \
AGNT_API_KEY= DEUS_CLOUD_AGNT_API_KEY= bun run dev:web
```

Then use the URLs printed by that dev process:

```bash
DEUS_TEST_BACKEND_URL=http://127.0.0.1:BACKEND_PORT \
DEUS_TEST_WEB_URL=http://localhost:VITE_PORT \
bun test/e2e/project-environment.runtime.mjs
```

The test closes its browser and retains the disposable repository, database and
screenshots in `.context/project-environment-app` for inspection. Stop that isolated
dev process after testing to release its terminals. Do not point this harness at the
user's desktop backend or normal database.

### `e2e-flow.test.cjs`

Comprehensive end-to-end test suite that verifies:

- ✅ Backend health check
- ✅ Workspace creation (new workspace, not existing)
- ✅ Message sending
- ✅ Claude CLI integration
- ✅ Database persistence
- ✅ State management

**Run the test:**

```bash
# Backend must be running first!
bun run dev:web  # Start in separate terminal

# Then run test (use the backend port from dev:web output)
export BACKEND_PORT=60068  # Use actual port from backend
bun run test:e2e

# Or specify port inline
BACKEND_PORT=60068 bun run test:e2e
```

**Duration**: ~20-30 seconds

**What it does:**

1. Creates a fresh workspace in the deus-machine repository
2. Waits for workspace to become ready
3. Sends a test message to Claude
4. Verifies Claude responds
5. Checks database storage
6. Archives the test workspace (cleanup)

## Requirements

- Backend must be running
- Database must be accessible at `~/Library/Application Support/com.deus.app/deus.db`

## Test Coverage

- ✅ HTTP API endpoints
- ✅ Message flow (User → Backend → Claude → Response)
- ✅ Database storage (sessions, messages, workspaces)
- ✅ State management (working/idle states)
- ✅ Cross-repository Claude CLI spawning
- ⚠️ Socket events (requires `socket.io-client` package)

## Adding New Tests

When creating new tests, follow these patterns:

1. **Name**: `feature-name.test.cjs`
2. **Structure**: Similar to `e2e-flow.test.cjs`
3. **Cleanup**: Always clean up test data
4. **Documentation**: Update this README

## CI/CD

To add tests to CI/CD pipeline:

```json
{
  "scripts": {
    "test": "node tests/e2e-flow.test.cjs",
    "test:watch": "nodemon tests/e2e-flow.test.cjs"
  }
}
```
