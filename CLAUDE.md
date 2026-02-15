# WHAT ARE WE BUILDING?

New IDE to manage multiple parallel AI coding agents at once.

This product is for semi-technical people who want to get the job done. They care more about the job output than the technology and code underneath.

We treat AI chat as a first-class citizen here, code it secondary.

# TechStack

Desktop app built with Tauri (Rust) + React frontend + Node.js backend.

## System Architecture

```
Frontend (React + Zustand + React Query)
    │
    ├── Tauri IPC ──→ Rust Backend (src-tauri/)
    │                  ├── Git operations (libgit2 — fast, stateless)
    │                  ├── File scanning (.gitignore-aware, cached)
    │                  ├── Terminal / PTY sessions
    │                  ├── Process lifecycle (Node.js backend, sidecar, dev-browser)
    │                  └── Socket relay (sidecar ↔ Tauri events)
    │
    ├── HTTP REST ──→ Node.js Backend (backend/)
    │                  ├── Database (SQLite — repos, workspaces, sessions, user messages)
    │                  ├── Workspace creation (git worktree + DB coordination)
    │                  ├── Config management (MCP servers, agents, hooks)
    │                  └── External services (GitHub PR status via gh CLI)
    │
    └── Socket ────→ Sidecar (sidecar/)
                       ├── Claude Agent SDK (streaming responses)
                       ├── Message transformation (SDK → DB format)
                       ├── Assistant message persistence (direct SQLite writes)
                       └── Real-time notifications → Rust → Tauri events → Frontend
```

### Message Flow

```
User sends message:
  Frontend → HTTP POST → Backend saves user message to DB
          → socketService.sendQuery() → Rust socket relay → Sidecar

Sidecar processes:
  Sidecar → Claude Agent SDK → streaming response
         → transforms message → saves to SQLite (better-sqlite3)
         → FrontendClient.sendMessage() → Rust socket → Tauri event

Frontend receives:
  Tauri event → useSessionEvents hook → invalidates React Query → UI updates
```

## Database: Standalone Hive Database

Our app owns its own SQLite database:

```
~/Library/Application Support/com.hivenet.app/hive.db
```

`initDatabase()` (in both `backend/src/lib/database.ts` and `sidecar/db/index.ts`) creates all tables, indexes, and triggers on first run via the `SCHEMA_SQL` constant defined in the corresponding `schema.ts` files. No external dependencies — the app is fully self-contained.

**Schema (5 tables):** `repos`, `workspaces`, `sessions`, `session_messages`, `settings`

**What this means for development:**

- All indexes, triggers, and denormalized columns are created by our own schema — see `backend/src/lib/schema.ts`
- `sessions.last_user_message_at` is maintained by app code — use it instead of correlated subqueries
- `sessions.workspace_id`, `sessions.agent_type`, `sessions.title`, etc. are available for multi-session support
- Both backend and sidecar access the same DB file (WAL mode enabled)
- Rust passes `DATABASE_PATH` env var to both Node.js processes

## Rust vs Node.js Boundary

- **Rust (Tauri commands):** Stateless pure functions. System-level ops. Performance-critical hot paths. File I/O, git operations, process management, terminal I/O, socket relay.
- **Node.js (Hono backend):** Business logic. Database reads/writes (repos, workspaces, user messages). Config management. External services (GitHub API via gh CLI).
- **Node.js (Sidecar):** Claude Agent SDK integration. Message transformation. Assistant message persistence. Real-time streaming to frontend.
- **Rule of thumb:** If it takes `(path, params) → data` with no database, it belongs in Rust. If it needs to read/write DB or coordinate async workflows, it stays in Node.js. If it involves Claude SDK streaming, it goes in the sidecar.

### Moving the Read Layer to Rust (Long-Term Direction)

This app is data-heavy: tens of repos, hundreds of workspaces, multiple concurrent agent sessions streaming in real-time. Routing every read through `Frontend → HTTP → Node.js → SQLite → HTTP → Frontend` adds per-request latency that compounds at scale. The long-term direction is to **move most DB reads to typed Rust Tauri commands** accessed via direct IPC, while Node.js stays focused on orchestration-heavy writes and external service coordination.

```
Frontend → Tauri IPC → Rust (typed query) → SQLite    ← reads (fast, direct)
Frontend → HTTP REST → Node.js → SQLite                ← writes + orchestration
```

**What belongs in Rust (reads):**

- Workspace status, session state, message fetching — anything the UI polls or renders frequently
- List queries (all workspaces, all sessions for a workspace, recent messages)
- Any read where the HTTP round-trip is noticeable

**What stays in Node.js (writes + orchestration):**

- Multi-step operations (create workspace = DB insert + git worktree + state transitions)
- Operations that coordinate with external services (GitHub API)
- Complex writes that involve business logic validation across multiple tables
- User message saving (triggers sidecar query via frontend socket)

**Implementation rules:**

- All Rust queries use typed structs and `sqlx::query_as!` — never raw SQL strings from the frontend
- The frontend calls `invoke("get_workspace_status", { id })`, never constructs SQL
- Rust commands are stateless reads: `(params) → data`. No business logic, no multi-step coordination
- Node.js keeps its service layer for anything that needs orchestration

## Rust Backend Structure (src-tauri/)

```
src-tauri/
├── src/
│   ├── main.rs              App init, plugin registration, lifecycle hooks
│   ├── lib.rs               Module exports
│   ├── commands/
│   │   ├── mod.rs           Re-exports all command modules
│   │   ├── pty.rs           Terminal: spawn, resize, write, kill
│   │   ├── socket.rs        Sidecar: connect, send, receive, disconnect
│   │   ├── backend.rs       Backend port discovery
│   │   ├── browser.rs       Dev-browser: start, stop, port, auth, status
│   │   ├── apps.rs          App detection: get_installed_apps, open_in_app
│   │   ├── files.rs         File scanning: scan, invalidate_cache, clear_cache
│   │   └── git.rs           Git Tauri commands (diff, status, branch, content)
│   ├── backend.rs           Node.js backend process manager
│   ├── browser.rs           Dev-browser process manager
│   ├── sidecar.rs           Sidecar process manager (spawns Node.js sidecar)
│   ├── pty.rs               PTY session manager
│   ├── socket.rs            Unix socket client (sidecar IPC relay)
│   ├── files.rs             File scanner with 30s cache
│   └── git.rs               Core git operations via libgit2
└── resources/
    └── bin/
        └── index.bundled.cjs  Sidecar bundle (built from sidecar/)
```

### Git Diff Semantics (src-tauri/src/git.rs)

- **Branch resolution** (`resolve_parent_branch`): Always prefers **remote** (`origin/{branch}`) over local. Worktrees are created from remote branches, so diffs must be against the upstream target. Never change this to local-first.
- **Diff computation** (`get_diff_stats`, `get_changed_files`, `get_file_patch`): Uses `diff_tree_to_workdir_with_index` (not `diff_tree_to_tree`). This diffs the merge-base tree against the **working directory**, capturing committed + staged + unstaged + untracked changes. AI agents often leave uncommitted changes — `diff_tree_to_tree` would miss them entirely.
- **Untracked files**: Diff options include `include_untracked(true)`, `recurse_untracked_dirs(true)`, `show_untracked_content(true)` so new files created by agents count toward diff stats.
- **Tauri IPC fallback**: Frontend `workspace.service.ts` wraps all Rust git calls in try-catch and falls through to HTTP when Tauri IPC fails (e.g., worktree deleted, HEAD missing).

## Node.js Backend Structure (backend/)

```
backend/src/
├── app.ts               Hono app factory, mounts all routes under /api
├── server.ts            Entry point, starts Hono via @hono/node-server
├── lib/
│   ├── database.ts      SQLite connection (better-sqlite3)
│   ├── errors.ts        AppError, NotFoundError, ValidationError, ConflictError
│   └── message-sanitizer.ts  JSON message safety for Claude responses
├── middleware/
│   ├── error-handler.ts Global error → JSON response mapper
│   └── workspace-loader.ts  Loads workspace by :id, sets path on context
├── services/
│   ├── claude.service.ts  Tool permission checking (canUseTool)
│   ├── git.service.ts     Git utilities (web-mode fallback, workspace creation)
│   ├── config.service.ts  File-based config (~/.hive/)
│   ├── settings.service.ts  SQLite key-value settings
│   └── workspace.service.ts  City name generator for workspaces
└── routes/
    ├── workspaces.ts    CRUD + diff endpoints (diff routes use Rust in desktop)
    ├── sessions.ts      Session CRUD + user message saving
    ├── repos.ts         Repository management
    ├── config.ts        MCP servers, commands, agents, hooks CRUD
    ├── settings.ts      Key-value settings
    ├── stats.ts         System statistics
    └── health.ts        Health check + port discovery
```

## Sidecar Structure (sidecar/)

The sidecar runs as a separate Node.js process, managed by Rust. It handles Claude Agent SDK communication and streams responses back to the frontend via Tauri events.

**Why a separate process?** The sidecar uses native modules (`better-sqlite3`) for direct DB writes and needs to run independently of the backend for clean separation of concerns.

**Bundling approach:** Uses `bundle.resources` in `tauri.conf.json` (not `externalBin`) because Node.js scripts with native modules can't be compiled to standalone binaries. The bundle includes the pre-built `index.bundled.cjs` file.

```
sidecar/
├── index.ts             Entry point, JSON-RPC server over Unix socket
├── build.ts             esbuild config → outputs to src-tauri/resources/bin/
├── vitest.config.ts     Test configuration
├── package.json         Sidecar-specific dependencies
├── rpc-connection.ts    Bidirectional JSON-RPC 2.0 peer over Unix socket
├── frontend-client.ts   FrontendClient: typed notifications → Rust → Tauri events
├── protocol.ts          Shared message type definitions
├── agents/
│   ├── agent-handler.ts   Abstract agent handler interface + registry
│   ├── env-builder.ts     Shell environment builder for agent processes
│   ├── shell-env.ts       Host shell environment detection
│   ├── hive-tools.ts      Hive MCP tools (AskUser, Diff, Terminal, etc.)
│   └── claude/
│       ├── claude-handler.ts    Claude Agent SDK integration
│       ├── claude-discovery.ts  Claude CLI executable discovery
│       ├── claude-sdk-options.ts SDK query options builder
│       ├── claude-session.ts    Session state management
│       ├── claude-models.ts     Model configuration
│       └── checkpoint.ts        Git checkpoint creation
├── db/
│   ├── index.ts         SQLite connection (better-sqlite3, WAL mode)
│   ├── session-writer.ts  saveAssistantMessage, updateSessionStatus
│   └── message-sanitizer.ts  JSON safety for Claude responses
└── test/
    └── ...              Unit tests for each module
```

### Key npm Scripts

```bash
npm run build:sidecar    # Build sidecar → src-tauri/resources/bin/index.bundled.cjs
npm run test:sidecar     # Run sidecar tests (198 tests)
npm run test:sidecar:watch  # Watch mode for sidecar tests
```

# RUNNING THE APP

## ⚠️ CRITICAL: Always run BOTH backend AND frontend together!

### For Web Development

```bash
npm run dev:full
```

This runs `./dev.sh` which starts:

- Backend server (Node.js) on a dynamic port (usually 50XXX)
- Frontend dev server (Vite) on http://localhost:1420/

### For Desktop Development

```bash
npm run tauri:dev
```

This runs everything: Vite + Backend + Tauri desktop app.

## ❌ NEVER DO THIS

```bash
npm run dev  # DON'T! This only runs frontend without backend!
```

## Troubleshooting

### Frontend port conflict

Vite will automatically use the next available port if 1420 is taken (e.g., 1421, 1422...).

If you need to kill a specific port:

```bash
lsof -ti:1420 | xargs kill -9
npm run dev:full
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
   - `.vibrancy-bg`, `.vibrancy-panel` (backdrop filters with Arc-style frosting)
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
- Use `npx shadcn@canary add button --overwrite` to refresh from upstream
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
└── platform/            ← Platform abstraction (Tauri IPC, socket)
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

### Keep your animations fast

- Default to use `ease-out` for most animations.
- Animations should never be longer than 1s (unless it's illustrative), most of them should be around 0.2s to 0.3s.

### Easing rules

- Don't use built-in CSS easings unless it's `ease` or `linear`.
- Use the following easings for their described use case:
  - **`ease-in`**: (Starts slow, speeds up) Should generally be avoided as it makes the UI feel slow.
    - `ease-in-quad`: `cubic-bezier(.55, .085, .68, .53)`
    - `ease-in-cubic`: `cubic-bezier(.550, .055, .675, .19)`
    - `ease-in-quart`: `cubic-bezier(.895, .03, .685, .22)`
    - `ease-in-quint`: `cubic-bezier(.755, .05, .855, .06)`
    - `ease-in-expo`: `cubic-bezier(.95, .05, .795, .035)`
    - `ease-in-circ`: `cubic-bezier(.6, .04, .98, .335)`
  - **`ease-out`**: (Starts fast, slows down) Best for elements entering the screen or user-initiated interactions.
    - `ease-out-quad`: `cubic-bezier(.25, .46, .45, .94)`
    - `ease-out-cubic`: `cubic-bezier(.215, .61, .355, 1)`
    - `ease-out-quart`: `cubic-bezier(.165, .84, .44, 1)`
    - `ease-out-quint`: `cubic-bezier(.23, 1, .32, 1)`
    - `ease-out-expo`: `cubic-bezier(.19, 1, .22, 1)`
    - `ease-out-circ`: `cubic-bezier(.075, .82, .165, 1)`
  - **`ease-in-out`**: (Smooth acceleration and deceleration) Perfect for elements moving within the screen.
    - `ease-in-out-quad`: `cubic-bezier(.455, .03, .515, .955)`
    - `ease-in-out-cubic`: `cubic-bezier(.645, .045, .355, 1)`
    - `ease-in-out-quart`: `cubic-bezier(.77, 0, .175, 1)`
    - `ease-in-out-quint`: `cubic-bezier(.86, 0, .07, 1)`
    - `ease-in-out-expo`: `cubic-bezier(1, 0, 0, 1)`
    - `ease-in-out-circ`: `cubic-bezier(.785, .135, .15, .86)`

### Hover transitions

- Use the built-in CSS `ease` with a duration of `200ms` for simple hover transitions like `color`, `background-color`, `opacity`.
- Fall back to easing rules for more complex hover transitions.
- Disable hover transitions on touch devices with the `@media (hover: hover) and (pointer: fine)` media query.

### Accessibility

- If `transform` is used in the animation, disable it in the `prefers-reduced-motion` media query.

### Origin-aware animations

- Elements should animate from the trigger. If you open a dropdown or a popover it should animate from the button. Change `transform-origin` according to the trigger position.

### Performance

- Stick to opacity and transforms when possible. Example: Animate using `transform` instead of `top`, `left`, etc. when trying to move an element.
- Do not animate drag gestures using CSS variables.
- Do not animate blur values higher than 20px.
- Use `will-change` to optimize your animation, but use it only for: `transform`, `opacity`, `clipPath`, `filter`.

### Animation Strategy: CSS-First

- **Primary approach:** CSS/Tailwind animations and transitions. The codebase uses `@keyframes` in `global.css` and Tailwind's built-in animation utilities.
- **Framer Motion:** Available but use sparingly — only when CSS can't handle the interaction (gesture-driven animations, layout animations, shared element transitions). Most animations should be pure CSS.

## Testing

Test if the backend or frontend works using the browser tool or running tests.

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
 * Event Flow: Backend → Unix Socket → Sidecar → Rust → Tauri Events → Frontend
 * We use Unix socket instead of HTTP SSE because:
 * - Infrastructure already existed (sidecar communication)
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

At 50 repos / 200+ workspaces / 10 active sessions, these are the hot pollers that dominate steady-state load. Numbers below are rough estimates and should be validated with telemetry, but they illustrate the order of magnitude.

| Interval | Source                                                | Estimated queries/sec |
| -------- | ----------------------------------------------------- | --------------------- |
| 2s       | `useWorkspacesByRepo` (list + per-row latest message) | ~100/s                |
| 2s       | `useStats` (8 full table scans)                       | ~4/s                  |
| 2-5s     | `useSession` per active session (x10)                 | ~3-5/s                |
| 5s       | `useDiffStats` per working workspace                  | ~2/s                  |
| 5s       | `useFileChanges` per working workspace                | ~2/s                  |

The single biggest offender is the N+1 pattern in the workspace list. Fixing that and de-duplicating polls yields immediate wins.

### Database Rules

**Required indexes** — any new table or query pattern must have proper indexes. All indexes are defined in `backend/src/lib/schema.ts` (and mirrored in `sidecar/db/schema.ts`). For any new query pattern, add an index to the schema:

```sql
-- Defined in schema.ts:
CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_role ON session_messages(session_id, role, created_at DESC);
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

**Events over polling** — on desktop (Tauri), prefer event-driven invalidation over polling. Currently only `session:message` uses Tauri events. Workspace state changes, session status changes, and new workspace creation should also emit events to eliminate polling.

**Polling budget** — the app should never exceed ~5 HTTP requests/second in steady state (all sources combined). Current state violates this: `useWorkspacesByRepo` (every 2s) + `useStats` (every 2s) + per-session polls = ~110 queries/s at scale.

**Polling frequency rules:**

- **2s polling**: Only for the single active/selected workspace's session when status is "working"
- **5-10s polling**: For sidebar workspace list (or replace with events)
- **30s+ / on-demand**: For everything else (settings, repos, config, PR status)
- **Never poll**: Data that can use Tauri events (messages on desktop, workspace state changes)

**Conditional polling** — always gate polling on relevant state. `useDiffStats` already does this (only polls when session is "working"). Apply the same pattern everywhere: don't poll idle workspaces, don't poll settings, don't poll repos.

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

### Read-Layer Migration Priority

When moving reads from Node.js HTTP to Rust Tauri IPC (see "Moving the Read Layer to Rust" above), prioritize by polling frequency:

1. **First**: `GET /workspaces/by-repo` — polled every 2s, heaviest query (N+1 + joins)
2. **Second**: `GET /stats` — polled every 2s, 8 full table scans
3. **Third**: `GET /sessions/:id` — polled every 2-5s per active session
4. **Fourth**: `GET /sessions/:id/messages` — polled every 2s in web mode
5. **Later**: On-demand reads (repos, settings, config, PR status)

Each migration should also fix the underlying query (add indexes, eliminate N+1, add pagination) — moving a bad query to Rust just makes it a faster bad query.

## AVOID AT ALL COST

- Never edit or even modify outside of your worktree directory — it's STRICTLY prohibited.
- Never start this app outside of your worktree directory — it's STRICTLY prohibited.
