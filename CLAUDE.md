# WHAT ARE WE BUILDING?

New IDE to manage multiple parallel AI coding agents at once.

This product is for semi-technical people who want to get the job done. They care more about the job output than the technology and code underneath.

We treat AI chat as a first-class citizen here, code it secondary.

# TechStack

Desktop app built with Electron + React frontend + Node.js backend. Monorepo structure with apps/ directory.

**Package manager: Bun.** Always use `bun` for installing dependencies (`bun add`, `bun install`), running scripts (`bun run`), and executing tools (`bunx`). Never use `npm` or `yarn` — CI runs `bun install --frozen-lockfile` and will fail if `bun.lock` is out of sync.

**Desktop + Mobile Web:** Primary target is the Electron desktop app. The web version (`app.deusmachine.ai`) also supports mobile browsers via `MobileLayout` (bottom tab bar with Chat/Code views, contextual PR bar). Mobile layout is detected with `useIsMobile()` and renders a simplified single-panel UI. Do not write browser-mode polling or `isElectronEnv` conditionals for feature parity — the HTTP/Node.js backend exists as a service layer accessed through the cloud relay in web mode. Electron IPC and WebSocket events are the primary data transport.

### ts-pattern (Pattern Matching)

Use `ts-pattern` for switch/case and if/else chains on discriminated unions. Prefer `.exhaustive()` to catch missing cases at compile time.

```tsx
import { match, P } from "ts-pattern";

// Discriminated union dispatch
return match(block)
  .with({ type: "text" }, (b) => <TextBlock block={b} />)
  .with({ type: "tool_use" }, (b) => <ToolUseBlock block={b} />)
  .with({ type: "thinking" }, (b) => <ThinkingBlock block={b} />)
  .otherwise(() => null);

// .exhaustive() — all cases MUST be handled (no default/fallback)
// .otherwise() — intentional fallback for open-ended matching
// P.union("a", "b") — match multiple values
// P.when(pred) — guard conditions
```

**When to use:** Any switch/case or if/else chain dispatching on `.type`, `.status`, `.state`, or similar discriminator fields.

## System Architecture

```
Frontend (React + Zustand + React Query)
    │
    ├── WebSocket ──→ Node.js Backend (apps/backend/)
    │                  ├── Query Protocol (q:subscribe/q:snapshot/q:delta)
    │                  │   All data: workspaces, stats, sessions, messages
    │                  ├── Commands (q:command/q:command_ack)
    │                  │   Async actions: sendMessage, stopSession
    │                  ├── Mutations (q:mutate/q:mutate_result)
    │                  │   Sync writes: archiveWorkspace, updateWorkspaceTitle
    │                  ├── Events (q:event) — ephemeral push (tool relay, plan mode)
    │                  └── Agent Client ──→ Agent-Server (apps/agent-server/)
    │                       ├── WebSocket (ws://127.0.0.1:{port}) — JSON-RPC 2.0
    │                       ├── turn/start, turn/cancel, turn/respond
    │                       ├── Receives canonical agent events → persists → pushes
    │                       └── Tool relay: agent → backend → frontend → backend → agent
    │
    ├── Electron IPC ──→ Electron Main (apps/desktop/)
    │                  ├── Git operations (via backend HTTP)
    │                  ├── File scanning (.gitignore-aware, cached)
    │                  ├── Terminal / PTY sessions (node-pty)
    │                  └── Process lifecycle (Node.js backend, agent-server, browser-server)
    │
    ├── HTTP REST ──→ Node.js Backend (apps/backend/)
    │                  ├── Fallback for initial load (before WS connects)
    │                  ├── Workspace creation (git worktree + DB coordination)
    │                  ├── Config management (MCP servers, agents, hooks)
    │                  └── External services (GitHub PR status via gh CLI)
    │
    └── Agent-Server (apps/agent-server/) — Stateless, no DB access
                       ├── Claude/Codex Agent SDKs (streaming responses)
                       ├── WebSocket server (JSON-RPC 2.0 with initialize handshake)
                       ├── Canonical event emission (13 event types → backend)
                       ├── Health endpoints (GET /health, GET /readyz)
                       └── Graceful shutdown with 30s turn draining
```

### Message Flow

```
User sends message:
  Frontend → q:command(sendMessage) → Backend WebSocket
  Backend: saves user message → forwards turn/start to agent-server (JSON-RPC)
  Agent-server ACK → q:command_ack → Frontend shows optimistic message

Agent-server processes:
  Agent SDK → agent-handler → canonical agent events (JSON-RPC notifications)
  Events flow to backend agent-client → agent-event-handler:
    → persist (agent-persistence.ts writes to SQLite)
    → invalidate (query-engine pushes q:delta/q:snapshot via WS)

Tool relay (bidirectional):
  Agent requests tool → tool.request event → backend tool-relay
  Backend pushes q:event { event: "tool:request" } to frontend
  Frontend handles (browser, diff, terminal, plan, question)
  Frontend sends q:tool_response → tool-relay resolves → agent-server receives result

Frontend receives (all via WebSocket):
  q:delta  → new messages merged into cache (cursor-based)
  q:snapshot → session status updated
  q:delta  → workspace sidebar updated (targeted, ~800B)
```

### WebSocket Query Protocol (`shared/types/query-protocol.ts`)

All real-time data flows through a single WebSocket connection to the backend (`/ws`). The protocol uses `q:` prefixed JSON frames:

**Frame types:**

```
DATA (reactive DB subscriptions):
  q:subscribe / q:unsubscribe  → client subscribes to a resource
  q:snapshot / q:delta          → server pushes full or incremental data

MUTATIONS (sync data writes):
  q:mutate / q:mutate_result    → archiveWorkspace, updateWorkspaceTitle

COMMANDS (async actions, ACK only):
  q:command / q:command_ack     → sendMessage, stopSession

EVENTS (ephemeral push, no subscription):
  q:event                       → tool relay requests, plan-mode, progress
```

**Resources:** `workspaces`, `stats`, `sessions`, `session`, `messages` — defined in `QUERY_RESOURCES` array in `shared/events.ts`.

**Frontend usage:**

```ts
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

// Subscribe to a resource — data pushed into React Query cache automatically
useQuerySubscription("workspaces", {
  queryKey: queryKeys.workspaces.byRepo(state),
  params: { state },
  mergeDelta: mergeWorkspaceDelta, // custom delta merge for RepoGroup[]
});
```

**Domain constants** in `shared/events.ts`:

- `QUERY_RESOURCES` — queryable data resources
- `MUTATION_NAMES` — sync write actions (`archiveWorkspace`, `updateWorkspaceTitle`)
- `COMMAND_NAMES` — async command actions (`sendMessage`, `stopSession`)
- `PROTOCOL_EVENTS` — typed ephemeral event names
- `AGENT_EVENT_NAMES` — canonical agent-server event types (13 events: session._, message._, tool._, request._)

### Electron IPC Events (streaming/control only)

Electron IPC events are used for streaming I/O and control signals — NOT for data subscriptions:

```ts
import { listen, WORKSPACE_PROGRESS, createListenerGroup } from "@/platform/electron";

const listeners = createListenerGroup();
listeners.register(listen(WORKSPACE_PROGRESS, (e) => e.payload.workspaceId));
return () => listeners.cleanup();
```

**Active IPC events:** `workspace:progress`, `fs:changed`, `pty-data`, `pty-exit`, `browser:*`, `chat-insert`, `git-clone-progress`. All defined in `shared/events.ts` with Zod schemas for runtime validation.

## Database: Standalone Deus Database

Our app owns its own SQLite database:

```
~/Library/Application Support/com.deus.app/deus.db
```

`initDatabase()` in `apps/backend/src/lib/database.ts` creates all tables, indexes, and triggers on first run via the `SCHEMA_SQL` constant defined in `shared/schema.ts`. No external dependencies — the app is fully self-contained.

**Schema (5 tables):** `repositories`, `workspaces`, `sessions`, `messages`, `paired_devices`

**What this means for development:**

- All indexes, triggers, and denormalized columns are created by our own schema — see `shared/schema.ts`
- `sessions.last_user_message_at` is maintained by app code — use it instead of correlated subqueries
- `sessions.workspace_id`, `sessions.agent_type`, `sessions.title`, etc. are available for multi-session support
- Only the backend writes to the DB — the agent-server is stateless (no DB access)
- Electron main process passes `DATABASE_PATH` env var to the backend child process

## Electron Main vs Node.js Backend Boundary

- **Electron Main Process:** Thin desktop shell. Window lifecycle, native OS dialogs, BrowserView management, auto-updater, process lifecycle (spawns backend + agent-server). No business logic.
- **Node.js (Hono backend):** All business logic. Database reads/writes (repos, workspaces, all messages). Config management. External services (GitHub API via gh CLI). Agent event persistence, tool relay coordination, PTY management, file watching.
- **Node.js (Agent-Server):** Stateless agent SDK wrapper. Claude/Codex SDK integration. Canonical event emission. No DB access — streams events to backend via WebSocket.
- **Rule of thumb:** If it needs a native Electron API (BrowserWindow, dialog, shell), it belongs in the main process. Everything else belongs in the backend or agent-server.

## Electron Main Process (apps/desktop/)

```
apps/desktop/
├── main/
│   ├── index.ts          App init, IPC handler registration, lifecycle hooks
│   ├── backend-process.ts  Node.js backend process management
│   ├── agent-server-process.ts  Agent-server process management
│   ├── native-handlers.ts  IPC handlers for native operations
│   └── browser-views.ts    BrowserView management for webview automation
└── preload/
    └── index.ts          Preload script exposing IPC bridge to renderer
```

Each domain (git, pty, files, browser, etc.) is handled by either the Electron main process (for native operations) or the Node.js backend (for data operations). The agent-server is spawned as a child process. The Electron main process manages process lifecycle and passes `AGENT_SERVER_URL` to the backend.

### Git Diff Semantics

- **Branch resolution** (`resolve_parent_branch`): Always prefers **remote** (`origin/{branch}`) over local. Worktrees are created from remote branches, so diffs must be against the upstream target. Never change this to local-first.
- **Diff computation** (`get_diff_stats`, `get_changed_files`, `get_file_patch`): Uses **git CLI** (`git diff --numstat <merge-base>`). Diffs compare the merge-base against the **working directory**, capturing committed + staged + unstaged changes. AI agents often leave uncommitted changes — `diff_tree_to_tree` would miss them entirely.
- **Untracked files**: Uses `git ls-files --others --exclude-standard` to list untracked files, then counts lines with size caps (10 MB) and binary detection. New files created by agents count toward diff stats.
- **Timeouts**: All git CLI calls use `spawn()` with deadlines (5s for short ops, 15s for diffs) to prevent hung processes from blocking the UI.
- **IPC fallback**: Frontend `workspace.service.ts` wraps all git calls in try-catch and falls through to HTTP when IPC fails (e.g., worktree deleted, HEAD missing).

## Node.js Backend Structure (apps/backend/)

```
apps/backend/src/
├── app.ts            Hono app factory, mounts all routes under /api
├── server.ts         Entry point, starts Hono + connects agent-client to agent-server
├── lib/              Database connection, error types, sanitizers
├── middleware/        Error handler, workspace loader
├── services/         Business logic + agent coordination:
│   ├── agent-client.ts        WebSocket client → agent-server (JSON-RPC 2.0)
│   ├── agent-event-handler.ts Dispatches canonical events → persist + invalidate
│   ├── agent-persistence.ts   DB write functions for agent events
│   ├── tool-relay.ts          Manages pending tool requests (agent ↔ frontend)
│   └── ...                    git, config, settings, workspace naming
└── routes/           REST endpoints (workspaces, sessions, repos, config, settings, stats, health)
```

Pattern: each route file maps to a REST resource. Services contain reusable business logic. Middleware loads context (workspace by `:id`) and maps errors to JSON responses. The agent-client connects to the agent-server on startup and dispatches all incoming canonical events through the agent-event-handler pipeline (persist → invalidate → WS push).

## Agent-Server Structure (apps/agent-server/)

The agent-server runs as a separate Node.js process, managed by the Electron main process. It wraps Claude/Codex SDKs and streams canonical events to the backend via WebSocket. It is **stateless** — no database access, no direct frontend communication.

**Why a separate process?** Agent SDKs are long-running and need process isolation. If an agent crashes, the backend and frontend remain unaffected. The agent-server can be restarted independently.

**Bundling approach:** The Electron main process spawns the bundled `index.bundled.cjs` file as a child process.

**Transport:** WebSocket server on `ws://127.0.0.1:{port}` (default). Also supports Unix socket (`--listen unix://`) for backward compat. JSON-RPC 2.0 wire protocol with `initialize`/`initialized` handshake.

```
apps/agent-server/
├── index.ts              Entry point, WebSocket + Unix socket server (JSON-RPC 2.0)
├── rpc-connection.ts     Bidirectional JSON-RPC 2.0 peer (WebSocket + net.Socket transport)
├── event-broadcaster.ts  Singleton: broadcasts canonical events to all connected clients
├── health.ts             Health endpoints (/health, /readyz) + graceful shutdown coordinator
├── protocol.ts           Zod-validated protocol definitions, re-exports shared/protocol.ts
├── agents/               Agent handler interface + SDK integrations
│   ├── agent-handler.ts  AgentHandler interface and multi-agent registry
│   ├── claude/           Claude SDK: discovery, session, models, SDK options
│   └── codex/            Codex SDK integration
└── test/                 Unit tests
```

### Canonical Agent Events (`shared/agent-events.ts`)

All agent output is normalized to 13 canonical event types that flow: Agent SDK → AgentHandler → EventBroadcaster → Backend agent-client → agent-event-handler → DB + WS push.

**Event categories:**

- **Session lifecycle:** `session.started`, `session.idle`, `session.error`, `session.cancelled`
- **Messages:** `message.assistant`, `message.tool_result`, `message.result`, `message.cancelled`
- **Requests:** `request.opened`, `request.resolved`
- **Tool relay:** `tool.request`, `tool.response`
- **Metadata:** `agent.session_id`, `session.title`

### Key Bun Scripts

```bash
bun run build:agent-server    # Build agent-server → apps/agent-server/dist/index.bundled.cjs
bun run test:agent-server     # Run agent-server tests (452 tests)
bun run test:agent-server:watch  # Watch mode for agent-server tests
```

# RUNNING THE APP

## ⚠️ CRITICAL: Always run BOTH backend AND frontend together!

### For Web Development

```bash
bun run dev:web
```

This runs `./dev.sh` which starts:

- Backend server (Node.js) on a dynamic port (usually 50XXX)
- Frontend dev server (Vite) on http://localhost:1420/

### For Desktop Development

```bash
bun run dev
```

This runs everything: Vite + Backend + Electron desktop app.

## ❌ NEVER DO THIS

```bash
bun run dev:frontend  # DON'T! This only runs frontend without backend!
```

## Troubleshooting

### Frontend port conflict

Vite will automatically use the next available port if 1420 is taken (e.g., 1421, 1422...).

If you need to kill a specific port:

```bash
lsof -ti:1420 | xargs kill -9
bun run dev:web
```

### Check what's running

- Frontend: http://localhost:1420/ (or next available port - check Vite output)
- Backend: Dynamic port (check terminal output for "Backend server started on port XXXXX")

# OUR FRONTEND

We want to achieve a beautiful aesthetic design of a pro consumer product.

Design inspiration from Linear, Vercel, Stripe, Airbnb, or Perplexity.

## State Management

Two-layer approach with clear separation of concerns:

- **Zustand** — UI state only (modals, selections, layout, sidebar). Fast, synchronous, local-first.
- **TanStack Query (React Query v5)** — Server/API state (workspaces, sessions, repos, messages, settings). Handles caching (5-min stale time), polling, optimistic mutations, and error/retry logic.

Each feature has its own query hooks in `src/features/{feature}/api/{feature}.queries.ts` and services in `src/features/{feature}/api/{feature}.service.ts`. Never mix: Zustand stores should not duplicate server data that TanStack Query already manages.

## Styling

### Tailwind CSS v4 - IMPORTANT Best Practices

We use **Tailwind CSS v4** which has significant differences from v3:

#### CSS-First Configuration

- **NO JavaScript config files** - v4 uses CSS-based configuration
- All configuration lives in `src/global.css` using `@theme` directive
- Never create or edit `tailwind.config.js` - it doesn't exist in v4

#### Color System - OKLCH Format

- Use modern **OKLCH color space** instead of HSL/RGB
- OKLCH provides perceptually uniform colors across all hues
- Example: `oklch(0.985 0 0)` for light gray, `oklch(0.59 0.24 264)` for primary blue
- Semantic colors defined in `:root` and `.dark` for theme switching

#### Theme Configuration

```css
@theme {
  /* Semantic colors reference CSS variables for dynamic theming */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);

  /* Custom design tokens */
  --font-family-sans: "Helvetica Neue", -apple-system, ...;
  --spacing: 0.25rem;
}
```

#### What NOT to Do in v4

- ❌ Don't use `@layer base`, `@layer components`, `@layer utilities` - not supported
- ❌ Don't use `@apply` directive in custom CSS - use vanilla CSS instead
- ❌ Don't use `@theme inline` - put everything in main `@theme` block
- ❌ Don't import packages like `tailwindcss-animate` - animations are built-in

#### Vite Integration

- Use `@tailwindcss/vite` plugin (NOT `@tailwindcss/postcss`)
- Import in `global.css`: `@import "tailwindcss";`
- Vite config: `plugins: [react(), tailwindcss()]`

#### Components.json for shadcn

```json
{
  "tailwind": {
    "config": "", // Empty - no JS config in v4
    "css": "src/global.css",
    "cssVariables": true
  }
}
```

### **What Goes Where: Styling Architecture** (CRITICAL)

This is the **single source of truth** for where different types of styling should live. Follow this religiously to avoid complexity bloat.

#### **Global CSS (src/global.css) - ONLY These Things:**

1. **@theme Block**: Design tokens (colors, fonts, spacing scales, z-index)
2. **@keyframes**: GPU-accelerated animations (`fadeIn`, `slideInRight`, etc.)
3. **Global Element Styles**: `html`, `body`, `#root`, scrollbars
4. **Complex Effects Tailwind Can't Do**:
   - `.vibrancy-bg`, `.vibrancy-panel` (backdrop filters with frosted glass effect)
   - `.bg-fade-overlay` (custom gradients)
   - `.markdown-content` (complex nested selectors for markdown rendering)
   - `.scrollbar-vibrancy` (custom scrollbar styling)
5. **Accessibility**: `@media (prefers-reduced-motion)`, `@media (hover: hover)`

#### **❌ Never Add to Global CSS:**

- ❌ Simple spacing utilities (`.space-standard` = `p-4`) → Use Tailwind `p-*`
- ❌ Simple shadows (`.elevation-1` = `shadow-sm`) → Use Tailwind `shadow-*`
- ❌ Typography utilities (`.text-large`) → Use Tailwind `text-*` or CSS variables
- ❌ Layout utilities (`.flex-center`) → Use Tailwind `flex items-center justify-center`
- ❌ Color utilities (`.bg-primary-light`) → Use Tailwind `bg-primary/80`

**Rule of thumb:** If Tailwind can do it in 2-3 classes, don't add a custom utility.

#### **Component Variants (src/components/ui/\*) - Use For:**

- Repeated styling patterns across the app (buttons, inputs, cards)
- Size variations: `size="sm"`, `size="lg"`
- Style variations: `variant="outline"`, `variant="ghost"`
- State variations: `data-state="active"`, `data-no-ring={true}`

**Example of Good Variant:**

```tsx
// ✅ GOOD - InputGroup with data-no-ring variant
<InputGroup data-no-ring={true} className="rounded-3xl shadow-lg">
```

**Example of Bad Override:**

```tsx
// ❌ BAD - Using !important to override
<InputGroup className="!ring-0 focus-within:!ring-0">
```

#### **Inline Tailwind Classes - Use For:**

- Layout: `flex`, `grid`, `gap-4`, `w-full`
- One-off adjustments: `rounded-3xl`, `shadow-lg`, `bg-muted/30`
- Responsive design: `sm:grid-cols-2`, `md:gap-6`, `lg:p-8`
- State variants: `hover:bg-accent`, `focus-visible:ring-2`, `disabled:opacity-50`

#### **Arbitrary Values - When to Use:**

Arbitrary values (`[...]`) are **acceptable** when:

- ✅ Using design system variables: `text-[var(--font-size-body-lg)]`
- ✅ Radix UI CSS variables: `h-[var(--radix-select-trigger-height)]`
- ✅ Specific design requirements with no Tailwind equivalent: `h-[1.2rem]`, `min-w-[88px]`

Arbitrary values are **anti-patterns** when:

- ❌ Tailwind has a utility: `rounded-[24px]` → `rounded-3xl`
- ❌ Overriding with !important: `!ring-0` → Fix the component variant instead
- ❌ Hardcoding colors: `bg-[#3b82f6]` → Use `bg-primary` or define in `@theme`

### Modern CSS Best Practices (Top-1% Quality)

These principles ensure maintainable, extendable styling that scales:

#### **1. Semantic HTML First, Styling Second**

- Use correct HTML elements: `<button>` not clickable `<div>`
- Proper ARIA semantics reduce CSS you need to write
- Example: `<button>` handles focus, keyboard, disabled states automatically

#### **2. Keep Specificity Low**

- One class deep most of the time
- Avoid deeply nested selectors: `❌ .list .card > h3.title`
- Prefer flat classes: `✅ .card-title`
- Use `data-*` attributes for variants: `<Button data-variant="outline">`

#### **3. Avoid !important**

- Only use in extreme cases (overriding third-party libraries, debugging)
- If you need `!important`, the specificity architecture is wrong
- Fix the root cause, don't bandage with `!important`

#### **4. Use CSS Variables for Everything**

- ❌ Never hardcode: `bg-blue-500`, `#3b82f6`, `rgba(59, 130, 246, 0.5)`
- ✅ Always use tokens: `bg-primary`, `var(--primary)`, `color-mix(in oklch, var(--primary) 50%, transparent)`
- Colors, spacing, radii, shadows, durations - all should be tokens

#### **5. Animate Only Transform & Opacity**

- These are GPU-accelerated and give 60fps animations
- ❌ Avoid animating: `width`, `height`, `top`, `left`, `margin`, `padding`
- ✅ Prefer animating: `transform`, `opacity`
- Use `will-change: transform` or `will-change: opacity` for animations

#### **6. Respect User Preferences**

```css
/* Disable animations for users who prefer reduced motion */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

#### **7. Use Container Queries for Components**

- Components should respond to their **container**, not viewport
- Already using in `card.tsx`: `@container/card-header`
- Prefer `@container` over `@media` for reusable components

```tsx
// ✅ GOOD - Adapts to container
<div className="@container">
  <div className="@sm:grid-cols-2 @lg:grid-cols-3">
    {/* Responds to parent width */}
  </div>
</div>

// ❌ BAD - Only responds to viewport
<div className="sm:grid-cols-2 lg:grid-cols-3">
  {/* Same size everywhere */}
</div>
```

#### **8. Use Logical Properties (Future-proof)**

- Makes layouts work in RTL languages and vertical writing modes
- `margin-inline` instead of `margin-left/margin-right`
- `padding-block` instead of `padding-top/padding-bottom`
- `inline-size` instead of `width`
- `block-size` instead of `height`

#### **9. Avoid Fixed Heights on Text**

- Let content define height
- Use `min-height`, `max-height`, or `clamp()` if needed
- ❌ `height: 200px` on a card with text
- ✅ `min-height: 200px` or just let it flow

#### **10. Use Modern Color Functions**

- `color-mix(in oklch, var(--primary) 25%, transparent)` for semi-transparent colors
- `oklch()` for perceptually uniform colors
- Already doing this! Keep it up.

#### **11. Avoid Unnecessary Flex Nesting**

- **Antipattern**: Wrapping a flex container in another flex container with no purpose
- Each flex container adds layout calculation overhead and default behaviors (gap, alignment)
- **Rule**: Only use flex when that specific container needs flex layout logic

```tsx
// ❌ BAD - Double flex with no purpose
<div className="flex">                     // Outer flex: Why?
  <div className="flex h-full gap-4">     // Inner flex: Does actual work
    <Child />
  </div>
</div>

// ✅ GOOD - Single flex with clear responsibility
<div className="h-full">                  // Block container: Height constraint
  <div className="flex h-full gap-4">     // Flex: Layout logic
    <Child />
  </div>
</div>

// ✅ ALSO GOOD - Double flex with different purposes
<div className="flex flex-col">           // Outer: Vertical stacking
  <Header />
  <div className="flex gap-4">            // Inner: Horizontal layout
    <Child />
  </div>
</div>
```

**Why this matters:**

- Default flex behaviors (align-items: stretch, gap) compound and create unexpected spacing
- Browser calculates layout twice unnecessarily (performance)
- Harder to debug when flex constraints conflict
- Violates single-responsibility principle

**Real example from our codebase:**

- TabsContent with `data-[state=active]:flex` wrapping another `flex` div created phantom padding
- Removing outer flex eliminated the spacing issue completely

### General Styling Guidelines

- Consistent paddings default 16px (this product is more dense)
- Consistent font sizes
- Consistent colors (avoid hardcoding colors at all costs)
- Always use font and color tokens from the Tailwind config

## Components

Maximize reusing of Shadcn components. If you want to design something new, explore src/components/ui/ to see if you can use something or build it from these components. They're the atomic components of all the design.

### Shadcn UI - Practical Best Practices

**Shadcn uses the "Open Code" model - you own the code and SHOULD edit it!**

The files in `src/components/ui/` are not a locked library - they're starter code that you're meant to customize for your design system. Editing them directly is the intended workflow.

#### When to Edit vs Wrap

**✅ Edit `components/ui/*` directly when:**

- Changing default styles (colors, borders, animations, radius, shadows)
- Adding new variants that should be available project-wide
- Fixing bugs or accessibility issues in the base component
- Adjusting animation timing or transition curves globally
- Changing default behavior (focus rings, hover states, disabled styles)

**✅ Create wrappers in `components/custom/*` when:**

- Adding app-specific behavior (analytics, feature flags, permissions)
- Combining multiple shadcn components into domain-specific patterns
- Creating product-specific variants (e.g., "DangerButton" with alert icon)
- Adding business logic that doesn't belong in base UI primitives

#### Best Practices

**1. Theme first, then component edits**

- Try CSS variables in `src/global.css` first (colors, radius, spacing)
- If you find yourself using `className` to override the same styles everywhere, edit the component instead
- Example: If every Button needs `rounded-lg` instead of `rounded-md`, edit `button.tsx` once

**2. Keep predictable APIs**

- Preserve standard props: `className`, `variant`, `size`, `asChild`
- Don't remove or rename these - consuming code depends on them
- Don't embed domain logic (feature flags, product copy) in `ui/*` files

**3. Track upstream changes**

- Watch [shadcn's changelog](https://ui.shadcn.com/docs/changelog) for component updates
- Use `bunx shadcn@canary add button --overwrite` to refresh from upstream
- Review Git diff and reapply your customizations after updates
- Commit with clear messages: `chore(ui/button): pull upstream + preserve custom variants`

**4. Prefer global fixes over per-component edits**

- Example: For cursor pointer on buttons, add CSS rule instead of editing each component:

```css
/* src/global.css */
button:not(:disabled),
[role="button"]:not(:disabled) {
  cursor: pointer;
}
```

**5. Use CSS variables for colors**

- ❌ Don't hardcode colors: `text-green-500 dark:text-green-400`
- ✅ Create semantic variables: `--color-status-success` → `text-[color:var(--status-success)]`
- This makes theming consistent and updates easier

#### Anti-Patterns to Avoid

❌ **Don't** use `!important` unless absolutely necessary (e.g., overriding third-party libraries)
❌ **Don't** hardcode colors - create CSS variables in `global.css` instead
❌ **Don't** add domain logic (API calls, feature flags) to `ui/*` components
❌ **Don't** feel guilty about editing shadcn components - it's the expected workflow!

#### Project Structure

```
src/
├── components/
│   └── ui/              ← Shadcn base components (EDIT FREELY)
│       ├── button.tsx   ← Add variants, change defaults
│       ├── badge.tsx    ← Adjust colors, add shapes
│       └── ...
├── shared/
│   └── components/      ← Cross-feature reusable compositions
├── features/
│   └── {feature}/ui/    ← Feature-scoped components (default)
└── platform/            ← Platform abstraction (Electron IPC, socket)
```

#### Real Examples from This Project

**✅ sidebar.tsx** - Modified animation timing globally (duration-[180ms] instead of default)
**✅ avatar.tsx** - Could add `shape` variant for `rounded-[8px]` squares vs `rounded-full` circles
**❌ SidebarHeader.tsx** - Currently uses className override `rounded-[8px]` - should edit avatar.tsx instead

### General Component Guidelines

- Split functionality into reusable components
- Follow single responsibility principle
- Keep component files focused and maintainable

### Component Architecture — Encapsulate, Don't Scatter

When building a new piece of UI, think about **what owns the concern**. If a visual element has its own data logic, state, or non-trivial rendering — it should be a **component**, not utility functions wired together in the parent.

#### The Rule: Encapsulate Self-Contained Concerns

**Ask yourself:** Does this piece of UI involve multiple steps (fetching/deriving data, computing styles, handling fallbacks, managing state)? If yes, it's a component.

```tsx
// ❌ BAD — Parent does all the work, utilities are just dumb helpers
function ParentItem({ repo }) {
  const owner = getRepoOwner(repo.name);
  const avatarUrl = getGitHubAvatarUrl(owner);
  const fallbackColor = getRepoFallbackColor(repo.name, isDark);
  const initial = repo.name[0].toUpperCase();

  return (
    <Avatar>
      {avatarUrl && <AvatarImage src={avatarUrl} />}
      <AvatarFallback style={{ backgroundColor: fallbackColor.bg }}>{initial}</AvatarFallback>
    </Avatar>
  );
}

// ✅ GOOD — Self-contained component owns its concern entirely
function ParentItem({ repo }) {
  return <RepoAvatar repoName={repo.name} />;
}
```

**Why the first approach is worse:**

- Parent now knows about GitHub URL patterns, OKLCH color math, theme detection, and fallback logic
- If you need the same avatar elsewhere, you copy-paste all that wiring
- Testing requires mocking multiple utilities in the parent's test
- The parent's responsibility is layout/interaction — not avatar rendering

#### When to Extract a Component vs Keep Inline

**Extract into its own component when:**

- It combines data derivation + rendering (e.g., fetch URL → try image → fallback to letter)
- It has its own internal state or hooks (e.g., `useTheme()`, `useState`)
- It's likely reusable in other parts of the app
- The logic is 10+ lines and distracts from the parent's main purpose

**Keep inline when:**

- It's pure layout (a `<div>` with some flex classes)
- It's a one-liner with no logic (e.g., `<Badge>{status}</Badge>`)
- It only makes sense in this specific parent context

#### Where New Components Live

```
src/features/{feature}/ui/     ← Feature-scoped components (default choice)
src/shared/components/          ← Cross-feature reusable compositions
src/components/ui/              ← Shadcn base primitives only
```

**Default to feature-scoped.** Only promote to `shared/components/` when a second feature actually needs it. Don't prematurely generalize.

## Animations Guidelines

### Project Defaults

- **Default easing:** `ease-out-quart` — `cubic-bezier(.165, .84, .44, 1)`. Use for most enter/exit animations.
- **Default duration:** 200-300ms. Never exceed 1s unless illustrative.
- **Don't use built-in CSS easings** (`ease-out`, `ease-in`, etc.) except `ease` for hover and `linear` for constant-speed. Always use custom cubic-bezier curves — see `web-animation-design` skill for the full catalog.
- **Hover transitions:** `200ms ease` for simple `color`, `background-color`, `opacity` changes. Disable on touch devices with `@media (hover: hover) and (pointer: fine)`.

### Performance

- Animate only `transform` and `opacity` — never `width`, `height`, `top`, `left`, `margin`, `padding`.
- `will-change` only for: `transform`, `opacity`, `clipPath`, `filter`.
- No blur values above 20px. No CSS variable animations for drag gestures.

### Animation Strategy: CSS + Framer Motion Hybrid

**CSS/Tailwind** — use for:

- Hover/focus transitions (`transition-colors duration-200 ease`)
- Infinite loops (spinners, shimmers, loading indicators)
- Tooltip/popover enter/exit
- Simple opacity/transform keyframes that don't need mount/unmount awareness

**Framer Motion** (`motion`, `AnimatePresence`) — use for:

- **Presence animations**: mount/unmount transitions (`AnimatePresence` + `initial`/`animate`/`exit`)
- **Layout animations**: items shifting position after reorder or sibling changes (`layout` prop)
- **Staggered lists**: children animating in sequence (`staggerChildren` in variants)
- **Height auto**: expanding/collapsing containers to `height: "auto"` (CSS can't animate to `auto`)

**Rules:**

- Co-locate animation config with the component, not in `global.css`
- Keep `global.css` for design tokens, complex effects Tailwind can't do, and truly global styles
- Never define a `@keyframes` in global.css for a single component — use Framer Motion inline
- Reuse transition configs: `{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }` (ease-out-quart)
- Always wrap conditional renders in `AnimatePresence` when exit animations are needed

## Testing

Test if the backend or frontend works using the browser tool or running tests.

- **Backend tests** live in `apps/backend/test/unit/` (organized by domain: `lib/`, `middleware/`, `routes/`, `services/`). Run with `bun run test:backend`.
- \*\*Agent-server tests live in `apps/agent-server/test/`. Run with `bun run test:agent-server`.
- Tests use Vitest with `vi.mock()` and `vi.hoisted()` for module-level mocking. Keep tests outside `src/` — never colocate tests with source code.

### Debugging Frontend Layout & Spacing Issues

Spacing and styling bugs are **never diagnosed from a single file**. The root cause almost always lives in a parent, grandparent, or sibling container. Before touching any CSS, you must **visualize the structure and backtrack the full component tree**.

#### The Rule: Draw the Divs First

Before changing any Tailwind classes, **outline every element** to see the actual box boundaries:

```css
/* Temporary — paste in DevTools or add to global.css while debugging */
* {
  outline: 1px solid rgba(255, 0, 0, 0.3) !important;
}
```

This reveals hidden padding, unexpected gaps, and wrapper divs contributing spacing you can't see in code alone.

#### The Rule: Backtrack Across Files

A visual section often spans 3-5 source files (`Page → Layout → Sidebar → SidebarItem → Avatar`). You **must read every file in the chain** — parent containers, the element itself, and its children. Check:

- **Parent/grandparent** containers for `p-*`, `gap-*`, flex alignment
- **Shadcn base components** (`src/components/ui/`) for built-in padding you inherit — always open the actual source file and read the CVA variants
- **CVA variant defaults** — components like `Button` apply default size/variant classes you don't see at the call site. Read `button.tsx`, `sidebar.tsx`, etc. to know what classes are baked in (e.g., `h-9 px-4 has-[>svg]:px-3` on every default-size Button)
- **Conditional selectors from base components** — `has-[>svg]:px-3` on Button activates when there's a child SVG (icons). Your `px-1` override won't help because the conditional selector has higher specificity. You must override with the **exact same modifier**: `has-[>svg]:px-1`, not `has-[&>svg]:px-1` (different modifier = twMerge won't merge them)
- **Siblings** whose margin or flex-grow steals space
- **`cn()` / twMerge** — only merges classes with **identical modifiers**. `has-[>svg]:px-3` and `has-[&>svg]:px-1` coexist instead of overriding. Always match the exact modifier string from the base component
- **Compound spacing** — parent `p-4` + child `m-2` + flex `gap-3` = 36px, not the 16px you expected

Never fix a spacing issue by only reading the file where the element is rendered. Always trace up and down the tree — and always open the base component source files to see what default classes you're inheriting.

## Documentation Policy

**CRITICAL:** Documentation lives IN the code, not in separate markdown files!

- ✅ **Add inline comments** for complex logic, architecture decisions, performance optimizations
- ✅ **Use JSDoc/TSDoc** for function documentation
- ❌ **NO separate .md files** for implementation details (they get outdated quickly)
- ✅ **Exception:** High-level docs are OK: README.md, ARCHITECTURE.md, CLAUDE.md, DEVELOPMENT.md

**Why:** Detailed docs get outdated. Code comments stay current.

**Example:**

```typescript
// ✅ GOOD - Document in the code:
/**
 * Event Flow: Backend → WebSocket → Agent-server → Backend → WS Push → Frontend
 * We use Unix socket instead of HTTP SSE because:
 * - Infrastructure already existed (agent-server communication)
 * - No HTTP overhead for desktop app
 * - ~150 lines vs ~200+ for SSE
 */
```

**What to document WHERE:**

- Code comments: Implementation details, why decisions were made, gotchas
- ARCHITECTURE.md: High-level system design, message flows
- README.md: Project overview, quick start, tech stack
- DEVELOPMENT.md: How to run the app, troubleshooting

## Performance Guidelines

This app manages tens of repos and hundreds of workspaces with multiple concurrent agent sessions. At that scale, naive patterns compound into real bottlenecks. Every agent working on this codebase must follow these rules.

### Request Volume at Scale (Example)

At 50 repos / 200+ workspaces / 10 active sessions, steady-state load is minimal. All data resources use WebSocket push subscriptions — no HTTP polling for data that has a WS subscription.

| Trigger | Source                                           | Transport                             |
| ------- | ------------------------------------------------ | ------------------------------------- |
| WS push | `useWorkspacesByRepo` (q:delta on status change) | WebSocket (~800B per workspace delta) |
| WS push | `useStats` (q:snapshot on any change)            | WebSocket                             |
| WS push | `useSession` (q:snapshot on status change)       | WebSocket                             |
| WS push | `useMessages` (q:delta cursor-based)             | WebSocket                             |
| 5s      | `useDiffStats` per working workspace             | HTTP                                  |
| 5s      | `useFileChanges` per working workspace           | HTTP                                  |

The only pollers are conditional git diff queries (only when sessions are "working"). All other data arrives via WebSocket push with no polling.

### Database Rules

**Required indexes** — any new table or query pattern must have proper indexes. All indexes are defined in `shared/schema.ts`. For any new query pattern, add an index to the schema:

```sql
-- Defined in schema.ts:
CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(session_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent_tool_use ON messages(parent_tool_use_id);
CREATE INDEX IF NOT EXISTS idx_paired_devices_token_hash ON paired_devices(token_hash);
```

**No N+1 queries** — never run a subquery per row in a list endpoint. Use `sessions.last_user_message_at` directly instead of correlated subqueries: `s.last_user_message_at as latest_message_sent_at`. When our code inserts a user message, it must also update this column. Prefer denormalization for frequently-JOINed aggregates over CTEs or window functions — it's simpler and proven at scale. When adding new list endpoints, always fetch related data in a single query or a batched second query, never in a loop.

**Paginate large collections** — session messages, file lists, and any unbounded collection must support pagination. Never return all rows from a table that can grow indefinitely. Default page size: 50-100 items.

**Consolidate count queries** — `GET /stats` currently runs 8 separate `COUNT(*)` full table scans. Aggregate queries should combine into a single query where possible, and results should be cached with short TTL (5-10s) for frequently polled endpoints.

**Auto-update triggers for `updated_at`** — every table with an `updated_at` column should have an `AFTER UPDATE` trigger that sets it automatically. This eliminates bugs where application code forgets to set the timestamp. Pattern (from production):

```sql
CREATE TRIGGER IF NOT EXISTS update_{table}_updated_at AFTER UPDATE ON {table}
BEGIN UPDATE {table} SET updated_at = datetime('now') WHERE id = NEW.id; END;
```

**PRAGMA optimize** — run `PRAGMA optimize;` on app startup (after migrations) and on graceful shutdown. This updates SQLite's internal statistics for better query planning.

**Column deprecation** — when removing a column, rename it with `DEPRECATED_` prefix (`ALTER TABLE x RENAME COLUMN old TO DEPRECATED_old`) instead of dropping it. This preserves data safety and is the pattern used in the production app's 75+ migrations.

### Polling Discipline

**WebSocket push over polling** — all data resources (workspaces, stats, sessions, messages) use WebSocket subscriptions. The backend pushes `q:snapshot` or `q:delta` frames directly to subscribers when data changes. No polling needed for subscribed resources.

**Polling budget** — the app should stay under ~5 HTTP requests/second in steady state. The only pollers are conditional git diff queries for working sessions.

**Polling frequency rules:**

- **2-5s polling**: Only for git diff hooks when status is "working" (diff stats, file changes)
- **30s+ / on-demand**: For everything else (settings, repos, config, PR status)
- **Never poll**: Data with a WS subscription (workspaces, stats, sessions, messages)

**Conditional polling** — always gate polling on relevant state. `useDiffStats` already does this (only polls when session is "working"). Apply the same pattern everywhere: don't poll idle workspaces, don't poll settings, don't poll repos.

**Adding a new data resource to WS:**

1. Add the resource name to `QUERY_RESOURCES` in `shared/events.ts`
2. Add a `runQuery` match arm in `apps/backend/src/services/query-engine.ts`
3. Add invalidation calls in `apps/backend/src/services/agent-event-handler.ts` (for agent-driven data) or the relevant route handler
4. Use `useQuerySubscription(resource, { queryKey, params })` in the frontend hook
5. Set `staleTime: Infinity` and `refetchOnWindowFocus: false` on the `useQuery` (WS handles freshness)

### Frontend Rendering Rules

**Virtualize all unbounded lists** — any list that can grow beyond ~30 items must use virtualization (`@tanstack/react-virtual`). This applies to:

- Sidebar workspace/repo list
- Chat message list
- File tree / file change list
- Any future list of agents, logs, or search results

**Zustand selector discipline** — never subscribe to an entire store. Always use individual selectors:

```tsx
// ❌ BAD — re-renders on ANY store change
const { collapsedRepos, toggleRepoCollapse } = useSidebarStore();

// ✅ GOOD — re-renders only when collapsedRepos changes
const collapsedRepos = useSidebarStore((s) => s.collapsedRepos);
const toggleRepoCollapse = useSidebarStore((s) => s.toggleRepoCollapse);
```

Use `useShallow` from zustand when selecting objects/arrays that are structurally equal but referentially different.

**Memoize list item components** — wrap components rendered inside `.map()` loops with `React.memo()` when they receive stable props. This prevents the entire list from re-rendering when a sibling changes.

**Batch related queries** — don't fire N independent queries from N list items. Use a single bulk endpoint or batch hook. `useBulkDiffStats` exists for this — prefer it over per-item `useDiffStats` in list views.

### Git + Subprocess Discipline

Git polling can dwarf DB time when scaled across many workspaces. Treat git calls as expensive and de-duplicate aggressively.

- Avoid per-item hooks that spawn git processes. Use bulk endpoints (one call per repo/workspace interval) and fan-out results in the UI.
- Cache diff/file-change results with a short TTL (5-10s) and reuse across components.
- Cap concurrent git subprocesses and queue excess work to prevent CPU spikes and I/O contention.

### Read-Layer Optimization Priority

All reads go through the Node.js backend via HTTP/WebSocket. When optimizing, prioritize by query weight:

1. **First**: `GET /workspaces/by-repo` — heaviest query (joins across repos + workspaces + sessions)
2. **Second**: `GET /stats` — consolidated count query
3. **Third**: `GET /sessions/:id` — frequently fetched for active sessions
4. **Fourth**: `GET /sessions/:id/messages` — paginated, cursor-based
5. **Later**: On-demand reads (repos, settings, config, PR status)

## AVOID AT ALL COST

- Never edit or even modify outside of your worktree directory — it's STRICTLY prohibited.
- Never start this app outside of your worktree directory — it's STRICTLY prohibited.
