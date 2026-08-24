# design/

`deus.pen` — the Deus Machine product, designed exactly as it is built.

Open it with Pencil (`open -a Pen design/deus.pen`) or in Deus itself via the Design tab
(`packages/pencil`). The file is encrypted: agents read and edit it through the Pencil MCP
tools only, never with plain file reads.

`sidebar-redesign.pen` is the exploration that produced the single-line sidebar rows
(PR #303). It is history — new work goes in `deus.pen`.

## How the canvas is organised

Top-level frames are numbered so the layer list reads in order, and laid out in bands on
the canvas — read left to right, top to bottom.

| Band                     | Frames     | What's there                                                                                                                                                                                       |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **00 — Overview**        | `00`       | The design ↔ code contract, on canvas                                                                                                                                                              |
| **01–05 — Foundations**  | `01`…`05`  | Colour / type / radius · motion & easing · elevation & materials · iconography · interaction states                                                                                                |
| **10–24 — Components**   | `10`…`24`  | The `DS/*` library, grouped: buttons, inputs, overlays, display, sidebar, chat, composer, tools, changes, tool anatomy, shell, content-panel states, remaining surfaces, markdown, transient flows |
| **30 — States**          | `30`       | Every workspace-row state side by side                                                                                                                                                             |
| **40–49 — Screens**      | `40`…`49`  | Workspace × each content tab, Home, Onboarding, light theme                                                                                                                                        |
| **50–58 — Settings**     | `50`…`58`  | All nine settings sections, full screen                                                                                                                                                            |
| **60–66 — Overlays**     | `60`…`66`  | ⌘K palette and every dialog                                                                                                                                                                        |
| **70–73 — Mobile**       | `70`…`73`  | Chat, Code, sidebar drawer, PR-bar states                                                                                                                                                          |
| **80 · 90 — Other apps** | `80`, `90` | The `/connect` web route, and the landing site (its own token set)                                                                                                                                 |

### Screens

- `40` Workspace — Changes · `41` Files · `42` Terminal · `43` Browser · `44` Design
- `45` Home — new workspace · `46` Home — zero repos
- `47a`…`47f` the full onboarding flow, in order: Welcome · Deus Cloud sign-in · Connect
  GitHub · AI coding tools · Your Projects · Shape Deus with us. It has its own visual
  language — pure black, a grain layer, white-on-white/10 surfaces, `text-white/50` copy —
  and does **not** use the app tokens. Don't "fix" it to match the rest.
  `StepIndicator` sits **above** the card (`pb-6`), not at the bottom of the screen, and
  step 0 doesn't render it at all. The active pip is `w-6`, steps already passed are
  `w-1.5 bg-white/50`, and the ones still ahead `w-1.5 bg-white/20` — three states, not two.
- `48` Light theme (the same surfaces with the `mode` axis flipped) · `49` Workspace in light
- `50` Account · `51` General · `52` GitHub · `53` Browser · `54` AI Providers · `55` Cloud ·
  `56` Environment · `57` Experimental · `58` Remote Access
- `54a`, `54b` and `54c` are a **proposal, not built** — a row-per-provider AI Providers
  section where each provider carries a Local and a Cloud lane (`54a`), its 14-state matrix
  (`54b`), and the four setup flows with every command and failure string from the main
  process (`54c`). They are the one deliberate divergence in this file. Either implement
  them in `AISection.tsx` (extracting the cloud-agent control so it can also stay mounted
  in Settings → Cloud) or delete all three boards. They must not sit here indefinitely.
- `60` ⌘K palette · `61` New workspace · `62` New from PR or branch · `63` Clone repository ·
  `64` Start new project · `65` System prompt · `66` Pair a device
- `70`…`73` Mobile: Chat · Code · sidebar drawer · PR-bar states
- `80` Connect to Server — the `/connect` web route
- `90` Landing — `deusmachine.ai` (`apps/landing`)

### The landing site is a different product

Board `90` is `apps/landing`, and it does **not** share the app's design system. It has its
own `styles.css`: shadcn neutral greys, **Geist Variable** rather than the system stack, a
different radius scale (`--radius: 0.625rem` with `sm/md/lg/xl/2xl` at 0.6 / 0.8 / 1 / 1.4
/ 1.8 ×), and its own `--code-surface`, `--status-active/pending/idle`.

Its variables are therefore namespaced `lp-*` — `lp-background`, `lp-foreground`,
`lp-primary`, `lp-muted-fg`, `lp-border`, `lp-code-surface`, `lp-radius-*`. **Never bind an
app screen to an `lp-*` token or vice versa.** They collide by name in CSS but are two
unrelated palettes.

It ships **dark only**: `__root.tsx` hard-codes `className="dark"` on `<html>` and there is
no toggle, so the `:root` light palette in `styles.css` is dead code. The board is drawn
dark for that reason.

Layout is a 620px prose column with a 176px sticky rail to its left (`right-full`, so the
rail hangs outside the column), 96px between sections, and copy capped at `54ch`. The hero
is `clamp(2.25rem, 5vw, 3.25rem)` — 52px at desktop.

This is the case that would justify splitting the file: a second consumer with its own
tokens. It stays here only because Pencil's agent API cannot create the `imports` map (see
below). If a third surface appears, revisit that.

### One-state surfaces

Boards `21` and `22` hold the surfaces that only ever appear as one state and so can't be
components: every content tab's idle state (Files select/scanning/empty, Terminal with no
tabs, Browser scanning / local-server list / nothing found, the Simulator device well, the
Apps launcher cards, the Agent config rail), plus the FileViewer, `WorkspaceStatusDashboard`,
`TaskRow`, the palette's workspace page, the AI-provider popover and the four update states.

## Variables → CSS custom properties

Pencil variables are named after their custom property in `apps/web/src/global.css`. The
`mode` theme axis carries both palettes: `light` is `:root`, `dark` is `.dark`.

| Pencil variable                                                          | CSS                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `bg-base` `bg-surface` `bg-elevated` `bg-raised` `bg-overlay` `bg-muted` | `--bg-*` — the six-tier background ramp                 |
| `bg-sidebar` `bg-selection` `bg-code`                                    | `--bg-sidebar` `--bg-selection` `--bg-code`             |
| `text-primary` … `text-disabled`                                         | `--text-*` — the five-level text hierarchy              |
| `border-subtle` `border-default` `border-strong` `sidebar-border`        | `--border-*`, `--sidebar-border`                        |
| `hover-overlay`                                                          | `hover:bg-foreground/[0.04]`                            |
| `accent`                                                                 | `--accent` (the user bubble surface)                    |
| `composer-bg`                                                            | `bg-bg-muted/75` — the composer glass                   |
| `primary` `primary-foreground` `success` `warning` `destructive`         | the semantic signals                                    |
| `accent-green` `accent-red` `accent-gold` + `-muted` variants            | `--accent-*`                                            |
| `status-in-review` `status-thinking`                                     | `--status-in-review`, `--status-thinking-indicator`     |
| `diff-add-*` `diff-del-*` `diff-linenum*`                                | `--diff-*` plus the resolved `--diffs-*-override` mixes |
| `text-2xs` … `text-3xl`                                                  | the 9 → 32px type scale in `@theme`                     |
| `radius-2xs` … `radius-full`                                             | the radius scale **after** `--corner-radius-scale`      |

OKLCH values are resolved to hex, because Pencil stores colours as hex. When a token
changes in `global.css`, convert and update the variable here — do not eyeball it.

## Two things the design file cannot render exactly

**Corners are squircles, not arcs.** `global.css` applies
`corner-shape: superellipse(1.5)` to `rounded-sm` → `rounded-4xl` and bumps
`--corner-radius-scale` to `1.25`, so every radius token ships 25 % larger than its base
value: `sm` is 7.5px, `md` 10, `lg` 12.5, `xl` 15, `2xl` 20. Those are the values used
throughout this file. Pencil can only draw circular corners, so every rounded rectangle
here is a stand-in for an Apple continuous-curvature corner — board `01` plots the two
curves side by side and overlaid so the difference is on record.

**Fonts are substitutes.** The app ships the system stack (`-apple-system` / SF Pro Text,
SF Mono). Pencil only carries Google fonts, so this file uses **Inter** for SF Pro Text and
**Roboto Mono** for SF Mono — the closest metric and texture matches available. Sizes,
line heights and tracking are the real values; only the outlines differ.

## Components → code

| Pencil component                                                     | Renders in                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DS/Button-Primary` … `-Destructive`                                 | `components/ui/button.tsx` (`buttonVariants`)                     |
| `DS/IconButton`                                                      | the 28px icon buttons in `SidebarHeader` / `SessionTabBar`        |
| `DS/Badge` `DS/Kbd` `DS/Input` `DS/Switch` `DS/Avatar` `DS/MenuItem` | the matching `components/ui/*.tsx`                                |
| `DS/Chip`                                                            | `QUICK_PROMPTS` chips in `features/repository/ui/HomeView.tsx`    |
| `DS/SidebarRow-Repo`                                                 | `features/sidebar/ui/RepositoryItem.tsx`                          |
| `DS/SidebarRow-Workspace` / `-Active`                                | `features/sidebar/ui/WorkspaceItem.tsx` + `SidebarRow.tsx`        |
| `DS/StatusIcon-*`                                                    | `features/sidebar/ui/WorkflowStatusIcon.tsx`                      |
| `DS/PixelGrid-Working`                                               | `features/session/ui/CircularPixelGrid.tsx` (`variant="working"`) |
| `DS/SessionTab-Active` / `-Idle`                                     | `components/ui/tab-pill.tsx` via `session/ui/tabs/SessionTab.tsx` |
| `DS/ContentTab-Active` / `-Idle`                                     | `app/layouts/ContentTabBar.tsx`                                   |
| `DS/ToolRow`                                                         | `session/ui/tools/components/BaseToolRenderer.tsx` (header row)   |
| `DS/TurnStatsHeader`                                                 | `session/ui/TurnStatsHeader.tsx`                                  |
| `DS/UserBubble`                                                      | `session/ui/MessageItem.tsx` (`UserMessage`)                      |
| `DS/Composer`                                                        | `session/ui/MessageInput.tsx` — the glass pill + toolbar          |
| `DS/DiffFileHeader`                                                  | `features/workspace/ui/ChangesDiffSection.tsx`                    |
| `DS/DiffLine-Add` / `-Del` / `-Ctx`                                  | the `diffs-theme` block in `global.css`                           |
| `DS/FileTreeRow`                                                     | `features/workspace/ui/ChangesFilesPanel.tsx`                     |

Specimens that are drawn from primitives rather than instanced (because they appear once)
live on the `12`–`19` boards and are captioned with the file they come from — dropdown /
popover / tooltip / dialog / sheet, the sidebar hover card and status menu, the composer's
staged-content cards and mention popovers, every tool renderer, and the changes filter.

### The scales are bound, not typed

Every `fontSize` and every `cornerRadius` in the file is a **variable reference**
(`$text-sm`, `$radius-lg`), not a literal. Change `radius-lg` once and every button, row
and tab follows; change `text-base` and the whole body scale moves. Don't type a number
where a token exists — if you need a value that isn't on the scale, that's a design
decision worth making explicitly.

Seven colour variables are defined but never referenced — `sidebar-border`,
`hover-overlay`, `accent-green-muted`, `status-thinking`, `diff-add-bg`, `diff-del-bg`,
`diff-linenum-bg`. That is deliberate: they mirror real CSS custom properties and appear
on the Foundations board as literal light/dark swatch pairs so both halves are visible at
once. Keep them in step with `global.css` even though nothing binds to them.

`DS/Badge`, `DS/Kbd`, `DS/StatusDot`, `DS/Input` and `DS/MenuItem` have no instances —
they appear once, on their own board, as the reference for a component that exists in
code. Everything else that appears more than once **is** instanced; if you find yourself
pasting a component's markup into a second place, instance it instead.

### The shell is a component

`DS/Sidebar` and `DS/SessionPanel` live on board `20` and are **instanced** into all five
workspace screens — only the content panel differs per screen. Edit the sidebar once and
Changes / Files / Terminal / Browser / Design all follow. Do not paste a second copy of the
shell into a new screen; instance it.

The exceptions are deliberate: the Home screens carry their own sidebar because nothing is
selected there (no active row) and the zero-repo screen shows the empty state instead of a
workspace list, and the light screen is primitives (see below).

### Tool calls

Board `17` lists all ~35 registered tools as collapsed header rows. Board `19` is the one
to read before adding a renderer: it labels the shared header row (glyph · name · summary ·
stats) and then shows the **nine body archetypes** every tool expands into —

`A` code block (Read, Write) · `B` unified diff (Edit, MultiEdit) · `C` terminal output
(Bash, BashOutput) · `D` result list (Glob, LS, ToolSearch) · `E` match block (Grep) ·
`F` checklist (TodoWrite) · `G` prompt + result (Task, Agent) · `H` prose (WebSearch,
WebFetch) · `I` error (any tool).

A new renderer picks one of the nine. If none fits, that is a design decision worth making
on the board first.

### Why this is one file, not several

The `.pen` format does support cross-file sharing — `Document` has an `imports` map of
alias → relative path to another `.pen`. But the agent-facing `execute` API has **no
operation to create or edit that map** (the verbs are Insert / Copy / Update / Replace /
Move / Delete / Generate / SetVariables and the readers). So a split design system would
have to be wired by hand in the Pencil UI and could not be maintained by an agent — which
is the whole point of this file.

Add to that: `execute` ignores its `filePath` and always edits the _active_ document, so
every cross-file edit means an open-switch-verify round trip, and that round trip is
exactly where the editor's layout and render go stale.

Split when there is a second consumer — a marketing site, the CLI, a second product —
that needs these tokens. Then `design/ds.pen` (variables + `DS/*` only) plus one file per
surface is the right shape. Until then one file is cheaper and safer, and the coupling
risk it was meant to solve is already handled by `DS/Sidebar` / `DS/SessionPanel`.

### Markdown

Board `23`. Every assistant message renders through `.markdown-content` in `global.css`,
which is a full type sheet, not a paragraph style: h1 22px/650 down to h6 11px uppercase
muted, asymmetric heading margins (large top, small bottom, so a heading binds to what
follows), 18px list indent with disc → circle → square nesting, a 2px blockquote rule at
`foreground/12`, inline code at 0.85em on `muted/60`, `pre` at 12px on `bg-code`, and
tables with a `muted/40` header and `muted/20` zebra rows. The board shows it rendered on
the left and specced on the right. `.thinking-markdown` reuses the same sheet with every
colour dropped to `foreground/62`.

### Transient flows

Board `24` holds the three surfaces that only exist mid-action, so they never show up in a
screenshot of the app at rest:

- **Diff comment** — select lines in Changes, a card opens inline (`.diff-comment-*` in
  `global.css`: no border, transparent, `radius-lg`, `10px 12px`, an ADDITION/DELETION
  pill at 9px/600). Sending it attaches a `DiffCommentPill` to the composer.
- **Browser focus mode** — the chat panel collapses and the composer is _portalled over
  the live page_, bottom-centred at `max-w-2xl`. No card, no backdrop, no blur: the
  composer's own pill chrome is the whole overlay.
- **Inspect prompt** — clicking an element with the picker opens a floating composer
  anchored to it, carrying the element as a `primary/8` chip.
- **Simulator** — `DeviceFrame` with real device geometry (iPhone 17 Pro is 1206 × 2622
  native), a header floating 10px above the screen so it never eats the device bounds, and
  the heaviest shadow in the app: `0 24px 80px` at `foreground/12` plus a 1px ring.

### Light mode

Board `49` is the full workspace screen in light, and board `48` is a component sheet in
light. Both are built from primitives rather than `DS/*` instances, because **a Pencil
component instance resolves its theme once per document** — duplicating a dark screen and
flipping `theme` to `light` does not work, the instances stay dark. That is a tool
limitation, not a design decision: in code there is one component set and two palettes.

## Geometry taken from the code

The screens are not approximations. The numbers below come from the source and should stay
in step with it:

- Sidebar `16rem` = 256px (`SIDEBAR_WIDTH` in `components/ui/sidebar.tsx`)
- Session / content panel split 40 / 60 (`MainContent.tsx`)
- `WorkspaceHeader` and the content panel header are `h-11` = 44px; `SessionTabBar` `h-10` = 40px
- Sidebar rows are 32px (`py-1.5 px-3`), repo rows 32px (`py-2 px-3`), icon slot 14×20
- Tool rows are `px-2 py-1.5` with a 14px icon box — `TurnStatsHeader` matches it exactly
- Composer is `rounded-2xl`, `bg-bg-muted/75`, hairline `ring-border-subtle`; controls are 32px
- Diff lines are 12px mono on an 18px line box, 22 % / 20 % tints over the background
- Settings body is `max-w-2xl` (672px) with `px-8 py-8`; the nav rail reuses the 256px sidebar
- Mobile is 390×844; the sidebar sheet is `100vw − 3.5rem` = 334px
- Sidebar header is 48px (`px-1.5 py-1.5` around a 36px account button); footer is 46px (`p-3.5`)
- Chat gutters are `px-6 pt-6` on desktop, `px-3 pt-4` on mobile. Turn rhythm is not a
  uniform gap: a user turn gets `pt-8` / `pb-8`, an assistant turn `pt-0` and `pb-1` only
  when another assistant turn follows. `TurnFooter` belongs **inside** the assistant turn.

### Things that are easy to get backwards

- **The Changes file list is on the RIGHT, and it is not the default.** Default is
  `ChangesMinimap`: a 24px strip of 2px coloured lines on the right edge. Hover slides a
  240px panel in from the right; pinning switches to a resizable 75 / 25 split with the
  diff still on the **left**. Both states are drawn on board `18`.
- **The content tab bar overflows.** `ALWAYS_PRIMARY_TAB_IDS` is
  `changes · files · terminal · browser`, plus whatever tab is active. Design, Simulator,
  Apps and Agent live behind the `⋯` menu unless selected. Primary order follows
  `CONTENT_TABS`, so an active Design tab sits between Terminal and Browser.
- **`PRActions` is `#N` first, then state.** The PR number link comes before the status
  pill / action button, and both take their colour from the PR state — `ready_to_merge`
  is a solid `bg-success` "Merge into {branch}", `ci_pending` a `bg-warning/10` chip,
  `awaiting_review` a `bg-primary/10` chip. With no PR it is a split Create PR button with
  a branch selector on the right half.
- **The header Open button is an outlined split button**, not a filled pill: a bordered
  `h-7` container, quick-open on the left, a 1px divider, and a chevron on the right.
- The Changes review CTA reads **"Review Changes"** with the file count after it.
- **A harness is drawn with its own logo, never a generic sparkle.** `apps/web/src/assets/agents/`
  ships 18 brand SVGs and `getAgentLogo(harness)` resolves them in six places: `ModelPicker`
  (trigger + every row), `ComposerControls`, `SessionTab`, `ClosedSessionsPopover`,
  `PlanApprovalOverlay` and `AgentQuestionOverlay`. The marks in this file are those exact
  paths, transcribed with their `viewBox="29 29 42 42"` and bound to a text colour the way
  `currentColor` behaves in code — so a `sparkles` icon in any of those slots is a bug.
- **Cloud setup counts three steps, and the GitHub one ticks on less than it looks like.**
  Either subscription satisfies the Agents step now that the sandbox runs
  `codex-app-server` — Codex counts. But an installed GitHub App only satisfies the repo
  step when it covers **every** local repo; with one repo missing the step stays open and
  the header still reads `1/3`, which is why board `55` is drawn that way. Each agent and
  GitHub row is an accordion — **one open at a time**, chevron rotated 180° when it is.
  That is why board `55` shows Claude Code open (paste a `claude setup-token`) and the
  Codex row's own expanded state lives on board `22`: one-click **Sign in with ChatGPT**
  with a ghost **Import existing** beside it, and the `codex login --device-auth` chip
  above them as the headless fallback.
- **A failed workspace stays in the sidebar.** `SIDEBAR_WORKSPACE_STATE` includes `error`
  precisely so the failure is visible, so the row needs a reason in the meta cell, not a
  red dot: `Cloud setup failed` while provisioning, `Sandbox failed` once it was up,
  plain `Failed` for a local worktree — all `text-accent-red-muted`, all on board `30`.

Motion values (curves, durations, press scales) are plotted on board `02`; overlay opacities
and focus-ring rules on board `05`. Both are read straight out of `global.css` and the
components — if you change an easing or a duration in code, change it there too.

## Working on the file

1. `open -a Pen design/deus.pen`, then confirm with `get_app_state` that it is the active
   editor — Pencil edits whatever document is open, regardless of the `filePath` argument.
2. Set variables before inserting nodes.
3. There is no autosave. Save with
   `osascript -e 'tell application "Pen" to activate' -e 'tell application "System Events" to keystroke "s" using command down'`.
4. Layout and rendering go stale during long sessions — bounds read back wrong and
   screenshots come out blank. Save, quit Pen, reopen, and they are correct again.
5. A component instance resolves its theme once per document, so the light-mode board is
   built from primitives rather than `DS/*` instances.
6. Keep the numbering and the bands. New screens get the next number in their band; new
   components go on the board they belong to, not loose at the document root.
