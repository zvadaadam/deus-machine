# Session Tabs Refactor

**Status:** planned, not yet executed
**Target:** separate PR (do not bundle with composer/focus-mode work)
**Scope estimate:** ~500 LOC touched across ~6 files, 1 rename, 4 new files

## Why

Today `apps/web/src/features/workspace/ui/MainContentTabs.tsx` is a 344-LOC god component that mixes five unrelated concerns:

1. Rendering individual chat-session tabs (with cross-fade status-icon slot)
2. Drag-reorder wiring (dnd-kit `DndContext` + sensors)
3. "+" new-tab button
4. Closed-sessions history popover
5. Collapse-chat-panel button

Beyond the LOC, the file has three distinct problems:

- **Wrong concern boundary.** The history popover is its own surface. The collapse-chat button is a panel control, not a tab. They live here because they share horizontal real estate — not because they share logic.
- **Real ARIA / keyboard regressions.** `<div role="tab">` instead of `<button role="tab">`, forcing a `stopPropagation()` hack. No arrow-key navigation (WAI-ARIA requires `←/→/Home/End` for tablist). No `⌘W` close. No `aria-controls` linking tab to panel.
- **Misnamed.** It's not "main content tabs" — it's session chat tabs. The comment at line 95 even says so: _"tabs-only bar for the chat area."_ Lives under `features/workspace/ui/` but it's session chrome, not workspace chrome.

## Incidental discovery

`Session.title` already exists on `shared/types/session.ts:131` as `title?: string | null`. It's declared but **never read or written anywhere in the codebase**. A future "rename session" feature needs almost no new infra — just wire `session.title` into label resolution as a fallback override.

## Adjacent-pattern facts (from code exploration)

- `BrowserTabBar.tsx` (sibling tab UI) is 165 LOC, single file, works fine. It's the reference shape — don't over-split.
- `apps/web/src/components/ui/tabs.tsx` exists (Radix-wrapped) but is **unused**. All three tab UIs hand-roll. Not building a universal `<Tabs>` primitive now — 3 call sites, each different enough that the abstraction would leak.
- Active-pill styling is already consistent across `BrowserTab` / `ContentTab` / `SessionTab`: `bg-bg-raised text-text-secondary`, `h-7`. Keep it.
- Tooltip delay is inconsistent: Browser/Content use **300ms**, MainContentTabs uses **200ms**. Normalize to 300ms.

## Proposed structure

Move from `features/workspace/ui/` to `features/session/ui/tabs/`. Parallel to `SessionComposer.tsx`, `SessionPanel.tsx`.

```text
apps/web/src/features/session/ui/tabs/
├── index.ts                     — barrel export
├── SessionTabBar.tsx            — orchestrator (~130 LOC)
│                                   props + DndContext + roving tabindex +
│                                   arrow-key navigation; renders: tab list,
│                                   "+" button, history popover trigger,
│                                   collapse-chat button
├── SessionTab.tsx               — one tab item (~80 LOC)
│                                   <button role="tab"> + status-icon slot
│                                   with cross-fade + drag wrapper + keyboard
├── ClosedSessionsPopover.tsx    — history popover (~55 LOC)
├── types.ts                     — SessionTab, ClosedSessionTab (~30 LOC)
```

**Why this split (and not more):**

- `SessionTab` has real complexity: cross-fade slot + keyboard + drag wrapper + a11y. Inlining 80 lines inside a `.map()` hurts readability.
- `ClosedSessionsPopover` is a completely different surface (its own popover with its own local state).
- Everything else (new button, collapse button, dnd setup) is cohesive with bar orchestration — splitting those would add navigation overhead for no clarity gain.

## Type tightening (no more `.data?.sessionId?`)

**Before** (`MainContentTabs.tsx:23-33`):

```ts
interface Tab {
  id: string;
  label: string;
  data?: {
    sessionId?: string; // optional-optional
    agentHarness?: string; // stringly typed
    hasStarted?: boolean;
    initialModel?: string;
  };
}
```

**After**:

```ts
export interface SessionTab {
  id: string; // stable dnd + React key (= sessionId today; separate for future flexibility)
  sessionId: string; // required — every session tab has one
  label: string;
  agentHarness: AgentHarness; // typed enum, not string
  hasStarted: boolean;
  initialModel?: string; // genuinely optional (only set for locked-group tabs)
}
```

Every consumer stops defensively null-checking `data?.sessionId?`.

## Fixes included beyond the split

Ordered by user-observable impact:

1. **`<button role="tab">`** instead of `<div role="tab">` + `stopPropagation` — drops the hack, gets native button semantics + keyboard for free.
2. **Roving tabindex + arrow-key navigation** — only the active tab has `tabIndex={0}`; others `-1`. `←/→/Home/End` move between tabs. WAI-ARIA baseline for tablist.
3. **Focus management on close** — closing a tab moves focus to the tab that becomes active (not lost to `<body>`).
4. **`⌘W` close** — keyboard parity with every other tabbed app. Wire in `useChatTabs.ts` next to `⌘T` / `⌘⇧T`.
5. **Icon-slot sizing to 7×7** (matches `BrowserTabBar`'s `w-7`) — fixes the spinner overflow (`CircularPixelGrid` is 14×14 in a 5×5 slot today) AND gives the close X the same hit target as browser tabs.
6. **Bar height `h-10` → `h-9`** — matches `BrowserTabBar`; 7px tab inside 9px bar is optically centered (1px top, 1px bottom).
7. **Tooltip delay 300ms** everywhere (match the 2 sibling tab UIs).
8. **Rename-ready label resolution.** In `useChatTabs.ts`, change one line:
   ```ts
   // current:
   label: hasStarted ? buildStartedChatLabel(agentHarness, sequence) : NEW_CHAT_LABEL,
   // future-ready:
   label: session.title ?? (hasStarted ? buildStartedChatLabel(agentHarness, sequence) : NEW_CHAT_LABEL),
   ```
   Zero visible behavior change (title is always null today). Unlocks a later rename feature with **no tab-UI changes** — just add the mutation + inline-edit UI on double-click.

## Callers to update

Mechanical ripples from the rename:

- `apps/web/src/app/layouts/ChatArea.tsx:15` — import site
- `apps/web/src/app/layouts/useChatTabs.ts:14` — type imports (`Tab`, `ClosedTab`)
- `apps/web/src/features/workspace/ui/index.ts:5` — re-export
- `apps/web/src/features/session/ui/index.ts` — add new barrel export

## Things explicitly out of scope

- **`useChatTabs.ts` stays in `app/layouts/`.** It's a layout hook and has 10+ interactions with layout concerns. Moving it would balloon the diff.
- **No universal `<Tabs>` primitive.** YAGNI — three hand-rolled tab UIs with different requirements. Abstracting now loses detail.
- **No inline rename UI in this pass.** That's a separate feature requiring a backend mutation (`PATCH /sessions/:id`) + UI (double-click or context-menu). This refactor just prepares the label-resolution code path.
- **MobileLayout unchanged.** It uses `MobileTabBar`, a completely separate bottom-nav codepath.
- **No `ICON_CROSS_FADE` extraction to shared.** Used in 2 places (this + `BrowserTabBar.tsx`). Duplicating a 1-line constant is cheaper than indirection.
- **`SortableTab.tsx` stays.** 44-LOC dnd-kit wrapper, does its job.

## Net impact

| Metric              | Before                   | After                          |
| ------------------- | ------------------------ | ------------------------------ |
| Biggest file        | 344 LOC                  | ~130 LOC (`SessionTabBar.tsx`) |
| File count          | 1                        | 4 (+ `types.ts`)               |
| Total LOC           | 344                      | ~295                           |
| `<div role="tab">`  | yes                      | no — proper `<button>`         |
| `stopPropagation()` | yes                      | no — correct nesting           |
| Arrow-key nav       | no                       | yes                            |
| `⌘W` close          | no                       | yes                            |
| Focus-on-close      | no                       | yes                            |
| Rename-ready        | no                       | yes (1-line hook change)       |
| Location            | `features/workspace/ui/` | `features/session/ui/tabs/`    |

## Ordered execution (when the PR opens)

1. Create `features/session/ui/tabs/types.ts` — `SessionTab`, `ClosedSessionTab` with strict shapes.
2. Create `features/session/ui/tabs/SessionTab.tsx` — per-item component with `<button role="tab">`, cross-fade slot, drag wrapper, roving-tabindex input.
3. Create `features/session/ui/tabs/ClosedSessionsPopover.tsx` — extract the popover; self-contained state.
4. Create `features/session/ui/tabs/SessionTabBar.tsx` — orchestrator with DndContext, arrow-key handler, composition of tab + "+" + popover + collapse.
5. Create `features/session/ui/tabs/index.ts` — barrel export.
6. Update `useChatTabs.ts`:
   - Update type imports
   - Add `⌘W` close shortcut next to `⌘T`
   - Change label resolution to `session.title ?? ...`
7. Update `ChatArea.tsx` import.
8. Update `features/workspace/ui/index.ts` — drop old re-export.
9. Delete `features/workspace/ui/MainContentTabs.tsx`.
10. Typecheck clean + smoke test:
    - Click / keyboard / arrow-key across tabs
    - Close via keyboard (`⌘W`)
    - Close via hover X (cross-fade)
    - Drag-reorder
    - Restore closed tab from history popover
    - `⌘⇧T` restore
    - Collapse chat panel
    - Workspace switch preserves active tab
    - Reload preserves tab order

## Smoke-test checklist

- [ ] `<button role="tab">` on every tab; no `<div>` antipatterns
- [ ] Active tab has `tabIndex={0}`; siblings `-1`
- [ ] `←` / `→` cycles focus between tabs; `Home` / `End` jumps to first / last
- [ ] `Enter` / `Space` selects focused tab
- [ ] Closing a tab moves focus to its replacement (not `<body>`)
- [ ] `⌘W` closes active tab (when >1 tab); no-op with 1 tab
- [ ] Icon cross-fade matches `BrowserTabBar` (same curve, same timing)
- [ ] Spinner doesn't clip in icon slot
- [ ] Drag-reorder works on mouse (5px threshold) and touch (250ms long-press)
- [ ] Restore popover shows closed tabs LIFO, capped at 20
- [ ] Tooltip delay 300ms (matches Browser/Content tab bars)
- [ ] No visual regression: active pill style, colors, heights match current look
