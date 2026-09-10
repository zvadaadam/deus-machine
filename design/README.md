# design/

`deus.pen` — the Deus Machine product, designed exactly as it is built.

Open it with the external Pencil app (`open -a Pen design/deus.pen`).
The file is encrypted: agents read and edit it through the Pencil MCP
tools only, never with plain file reads.

`sidebar-redesign.pen` is the exploration that produced the single-line sidebar rows
(PR #303). It is history — new work goes in `deus.pen`.

## How the canvas is organised

Top-level frames are numbered so the layer list reads in order, and laid out in bands on
the canvas — read left to right, top to bottom.

| Band                    | Frames           | What's there                                                                                                                                                                                                                |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **00 — Overview**       | `00`             | The design ↔ code contract, on canvas                                                                                                                                                                                       |
| **01–05 — Foundations** | `01`…`05`        | Colour / type / radius · motion & easing · elevation & materials · iconography · interaction states                                                                                                                         |
| **10–25 — Components**  | `10`…`25`        | The `DS/*` library, grouped: buttons, inputs, overlays, display, sidebar, chat, composer, tools, changes, tool anatomy, shell, content-panel states, remaining surfaces, markdown, transient flows, provider & access parts |
| **30 — States**         | `30`             | Every workspace-row state side by side                                                                                                                                                                                      |
| **40–49 — Screens**     | `40`…`49`        | Workspace × each content tab, Home, Onboarding, light theme                                                                                                                                                                 |
| **50–59 — Settings**    | `50`…`59a`       | Its own lane at x 19,000. Four bands: shipped sections · sub-pages · overlays · explorations                                                                                                                                |
| **60–67 — Overlays**    | `60`…`67`        | ⌘K palette, every dialog, and Grant repository access                                                                                                                                                                       |
| **70–75 — Mobile**      | `70`…`75`        | Chat, Code, sidebar drawer, PR-bar states, repository environments, web-direct chat                                                                                                                                         |
| **80 · 85 · 90**        | `80`, `85`, `90` | The `/connect` web route, the web-direct surfaces, and the landing site (its own token set)                                                                                                                                 |

### Screens

- `40` Workspace — Changes · `41` Files · `42` Terminal · `43` Browser · `44` Design
- `45` Home — new workspace · `46` Home — zero repos
- `46a`…`46d` and `46x` — Automations (plan in `docs/automations-plan.md`; **built,
  cloud-only**: `features/automations/` + `services/automations/`). `46a` the list view
  — the sidebar gains an Automations NAV ROW directly under the header, above the repo
  list (Cursor's placement, user-directed 2026-08-27; `AppSidebar.tsx` — the board still
  draws the earlier footer placement); the main area is the Home-style inset with list +
  suggestions (`AutomationsListView.tsx`). Code-only provenance the boards don't show
  yet: automation-born workspaces carry a zap beside the name in the sidebar row
  (`WorkspaceItem.tsx`) and an automation chip in the workspace header that deep-links
  to the run history (`WorkspaceHeader.tsx`). `46b` the create surface — **deliberately not a dialog**:
  the list compresses to a 340px rail and the editor fills the right with a back
  affordance (`AutomationRail.tsx` + `AutomationEditor.tsx`). `46c` the same split
  showing detail + run history (`AutomationDetail.tsx`). `46d` the chat pieces — the
  `automation_update` tool card (`AutomationToolRenderer.tsx`, archetype G), the
  auto-pause banner, the empty state; the run-provenance chip is still design-only.
  KNOWN DIVERGENCE (boards predate the cloud-only decision): `46b` still draws the
  Cloud/This-Mac segmented control and the Notifications select — shipped code has
  neither (a static "runs in your Deus Cloud sandbox" note instead), the row lane
  chips are gone, and the quit-warning note no longer applies. Trim the boards next
  time deus.pen is the active Pen document. `46x` the ChatGPT/Cursor reference
  screenshots (PNGs in `references/automations/`, teardown notes in the captions).
- `47a`…`47f` the full onboarding flow, in order: Welcome · Deus Cloud sign-in · Connect
  GitHub · AI coding tools · Your Projects · Shape Deus with us. It has its own visual
  language — pure black, a grain layer, white-on-white/10 surfaces, `text-white/50` copy —
  and does **not** use the app tokens. Don't "fix" it to match the rest.
  `StepIndicator` sits **above** the card (`pb-6`), not at the bottom of the screen, and
  step 0 doesn't render it at all. The active pip is `w-6`, steps already passed are
  `w-1.5 bg-white/50`, and the ones still ahead `w-1.5 bg-white/20` — three states, not two.
- `48` Light theme (the same surfaces with the `mode` axis flipped) · `49` Workspace in light
- `50` Account · `51` General · `52` GitHub · `53` Browser · `54` AI Providers · `55` Cloud ·
  `56` Environments · `57` Experimental · `58` Remote Access

### The settings lane

Settings is the largest district in the file, so it has its own lane rather than sharing
the x 0 column with dialogs, mobile and onboarding. Origin **x 19,000**, pitch **1,560**
(1,440 board + 120 gutter), four baselines:

| Band | y     | Frames                                    |
| ---- | ----- | ----------------------------------------- |
| 1    | 6400  | `50`…`58` — shipped sections              |
| 2    | 7600  | `56a` `56b` `56c` `56e` `56f` `56g` `56h` |
| 3    | 8800  | `66a` `66b` — settings overlays           |
| —    | 10000 | The `EXPLORATIONS — NOT BUILT` lane rule  |
| 4    | 10300 | `54a` `54b` `54c` `54d` `59` `59a`        |

Explorations sit below the rule and each carries a `PROPOSAL — NOT BUILT YET` mark on the
board, so nothing unshipped reads as a tenth section. A board that is not built says so on
the board. Mobile boards live in `70`–`79` whatever they show, which is why the mobile
repository-environments board is `74` and not `56d`. A number means one board: `42`, `43`,
`62` and `72` were each used twice, so the web-direct district moved to `85`/`85a`–`85e`,
Grant repository access to `67`, and the web-direct mobile chat to `75`.

- `58` labels the portal address **Access URL** without a copy button. **Connect a Device**
  opens the existing pairing dialog (`66`); its Copy Link and QR code include the pairing
  code. The link keeps that code through the browser redirect and targets the signed-in
  iOS pairing flow when the native app is installed and associated with the domain.
- `54a`–`54d` and `59`/`59a` are a **proposal, not built** — the settings revamp, parked in
  band 4. `54d` is the exception that had to be untangled first: it housed
  `DS/ProviderAccounts — connected`, `DS/ProviderDeviceLogin — waiting` and
  `DS/AuthBadge — unavailable`, and shipped board `54` instances the first of them. All
  three now live on board `25`, and `54d` renders them as instances, so the exploration can
  be moved or archived without breaking a shipped screen. `54a` is
  the row-per-provider AI Providers section with a Local and a Cloud lane, `54b` its
  local status matrix. Superseded cloud setup/state diagrams are removed from `22`, `54b`, and `54c`; `54d` is the current cloud flow.
  `59` carries the system behind it — the `cell` row primitive
  (leading · trailing · below, hairline inset dividers, no card per row, controls sized to
  their content) and a regrouped nav — and `59a` applies it to General. The primitive is
  lifted from Cursor's own `.cursor-settings-cell`, read out of its app bundle.
  These boards are the file's one deliberate divergence: either implement them or delete
  them. They must not sit here indefinitely.
- `54d` is the implemented **shared cloud provider accounts** flow in
  `features/settings/ui/sections/ProviderAccounts.tsx`: API-key creation/replacement,
  subscription device approval and token setup, named accounts, one default per
  provider, rename, reconnect, disconnect and error states. Claude offers API keys and
  personal subscription tokens from `claude setup-token`; Codex offers API keys
  and ChatGPT device approval. Both support multiple named accounts. The old
  desktop subscription vaults and imports are removed.
  `DS/ProviderAccounts` and `DS/ProviderDeviceLogin` map to those two components.
  Saved-account rows are rendered by the adjacent `ProviderAccountRow.tsx`; it uses
  the same layout and states shown in `54d`.
  Names can be edited without replacing credentials or changing the default.
  Claude setup tokens do not expose a verified email; the name identifies the account.
  Board `54` puts cloud accounts before local CLI connections and removes the inert
  local API-key inputs; `55` shows both provider defaults and links to AI Providers.
  Hosted web exposes Account and AI Providers, without desktop CLI controls.
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
the palette's workspace page, the AI-provider popover and the four update states.
Board `22` also holds the Run app / environment settings controls and the cloud
Computer ready row. The retired `TaskRow` editor has been removed.

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
| `DS/Breadcrumbs`                                                     | the settings sub-page trail (no component in code yet)            |
| `DS/ProviderAccounts` `DS/ProviderDeviceLogin` `DS/AuthBadge`        | `features/settings/ui/sections/ProviderAccounts.tsx` — board `25` |
| `DS/GrantRepositoryAccessModal`                                      | the repository-access modal — board `25`                          |
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
| `DS/HeaderRunButton`                                                 | `features/workspace/ui/HeaderRunButton.tsx`                       |
| `DS/CloudEnvProgress`                                                | `features/session/ui/CloudEnvProgress.tsx`                        |
| `DS/DiffFileHeader`                                                  | `features/workspace/ui/ChangesDiffSection.tsx`                    |
| `DS/DiffLine-Add` / `-Del` / `-Ctx`                                  | the `diffs-theme` block in `global.css`                           |
| `DS/FileTreeRow`                                                     | `features/workspace/ui/ChangesFilesPanel.tsx`                     |

Specimens that are drawn from primitives rather than instanced (because they appear once)
live on the `12`–`19` boards and are captioned with the file they come from — dropdown /
popover / tooltip / dialog / sheet, the sidebar hover card and status menu, the composer's
staged-content cards and mention popovers, every tool renderer, and the changes filter.

Board `13` includes the cloud autosave warning from
`features/session/cloud/notifyCloudAutosaveFailure.ts`, rendered by the existing
`components/ui/sonner.tsx` toaster. It shows a live failed-save diagnostic for ten
seconds or until dismissed; it is not a persistent chat component.

Board `56` shows the repository list in `EnvironmentSection.tsx`, with GitHub owner
avatars and cloud/local availability. `56a` shows shared Setup/Run and public
variables through `ProjectEnvironmentEditor.tsx`; `56b` shows the same form editing
`.deus/environment.json` with branch/publication context. The repository header includes
a clickable GitHub URL. Horizontal Local / Cloud tabs sit below it and choose where
the agent sets up a workspace; both use the same recipe form. The workspace
header opens its repository directly with its location selected. `56c` manages secrets across
repositories; `74` is the mobile list; `56e` shows a signed-in account when cloud
settings cannot be loaded, with retry and no sign-in prompt. The breadcrumb returns
to repositories. `56h` shows the account-switch loading state: repository editing
waits until the new account's organization context is loaded, preserving navigation.

Board `13` shows the single Set up this project suggestion: only an empty, idle chat
whose recipe lookup confirms it is unconfigured. Board `22` distinguishes Run app
(the local recipe's Run command, opened in a terminal) from Computer ready (cloud
provisioning completed). Cloud app startup remains owned by AGNT.

### The settings header

The settings `TopBar` is the breadcrumb bar. On a root section it holds the section
name; on a sub-page it holds a `DS/Breadcrumbs` instance — back arrow, parent crumb,
`›`, current crumb — and nothing else. The sidebar-collapse toggle is gone from every
settings board: settings is a full-screen surface, so there is no panel to collapse.

Sub-pages carry no second section title. `Environments` / "Set up how your repositories
run." belongs to root board `56` only. Repeating it on `56a`–`56g` pushed the real page
title down and made the crumb read `Repositories › acme/mobile-app` under a heading that
said `Environments`. The trail now names the section it returns to, the page title sits
directly below it at `text-lg`/600, and the nav item, the crumb and the root heading all
say **Environments**. The back arrow is the part Cursor omits and Deus keeps.

The organization selector stays on the boards where it scopes what you see — root `56`
and the `56c`/`56f`/`56g` secrets boards, on the title row. It is gone from `56a`/`56b`:
a repository already fixes its organization.

Every settings `Body` is **1048px** wide with `[0, 32]` padding — 984px of content, 96px
clear of the card edge on both sides. Before, form sections ran 672px inside an 1176px
card, which left 252px of dead surface on each side.

`56c` uses that full width for the table. Shared and Personal are tabs with
counts, and the secrets themselves sit in the same bordered table as `56`
(`bg-muted` heading band, `border-subtle` row rules) with Name, Applies to, Value
and the Replace/Delete actions. Values are always masked because
`EnvironmentSecret` carries metadata only. `56f` is the empty table and `56g` opens
the new-secret side panel over it: scope segmented control, name, value, applies-to,
and the write-only note. The panel replaces the centred `EnvironmentSecretDialog`
(`66a`) for the add case; replace and delete stay dialogs.
Cloud setup preserves saved command boundaries, phases and parallel steps.
Cloud Run script starts the app after setup in each new VM. Both script fields
sit above a divider and environment variables; the Local workspace-status block
is removed. Cloud values can be added before saving scripts. Dropping an `.env`
or `.dev.vars` file opens a name-only import review; selected non-empty values
are saved as personal or shared secrets in one transaction.
Both repository detail boards have one **Set up with agent** action in the repository
header, targeting the selected Local/Cloud tab. Local setup shows public variables
after setup/run scripts; archive scripts, tasks and requirements stay in Advanced.
The Generate, Auto-detect and JSON-preview controls are removed.
Board `66a` shows add, replace and delete states of `EnvironmentSecretDialog.tsx`.
Board `66b` shows `ImportEnvironmentSecretsDialog.tsx`, including replacement,
empty values and multi-environment scope conflicts. Local public variables remain
separate from Cloud secrets.
Values are write-only; existing values are never drawn into a replacement form.
The page determines a new secret's repository scope; the dialog only asks whether
it is personal or shared. Defaults are inherited and managed on their own page.
The forms reuse the input and button components. `assets/github-acme.png` is the
public GitHub owner avatar used in these examples, fetched from GitHub's profile
image endpoint. Production loads owner avatars directly and uses a folder fallback.

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

`DS/Badge`, `DS/Kbd`, `DS/StatusDot` and `DS/MenuItem` have no instances —
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
- Settings body is 1048px across every section (`max-w-5xl`, was `max-w-2xl`/`max-w-4xl`)
  with `px-4 py-8 sm:px-8`; the nav rail reuses the 256px sidebar
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
- **Cloud setup counts three steps.** A connected personal default account satisfies
  the Agents step. Board `55` shows a connected Codex account and links to
  **Manage accounts** in AI Providers; it has no separate provider token forms.
  GitHub completes only when a PAT is present or the installed App covers every
  local repo. The GitHub App and PAT rows remain accordions, one open at a time.
- **A failed workspace stays in the sidebar.** `SIDEBAR_WORKSPACE_STATE` includes `error`
  precisely so the failure is visible, so the row needs a reason in the meta cell, not a
  red dot: `Computer failed` for a cloud workspace, `Failed` for a local worktree —
  both `text-accent-red-muted`, both on board `30`. The row's hover retains the specific
  stored error, including provisioning failures.

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

### Cloud wake recovery

`30a · States — Cloud availability` records `CloudSandboxGate` after a failed wake,
normal sleep, and a workspace error. `13` includes the corresponding header chips;
`14` includes sidebar availability examples. All three surfaces derive from
`features/workspace/lib/cloudPresence.ts`: a ready row with a wake error is
**Unavailable** with retry; a workspace error remains **Failed**. Successful running
events lift the gate. A failed HTTP refresh preserves an existing serving connection.

### Unconfirmed Stop

`30b · States — Unconfirmed Stop` shows the existing Chat alert while a turn remains
active, and a pending plan alongside the composer. `DS/Composer` has a hidden Stop
slot that those active-state instances enable. Stop stays available in `working`,
`needs_response`, and `needs_plan_response`; an unconfirmed cancellation leaves the
request answerable until the native turn ends. The alert stays visible in all
three active states, without replacing a waiting status with `working`.
