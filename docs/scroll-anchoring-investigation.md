# Scroll Anchoring During Expand/Collapse — Investigation & Deferred Fix

**Date:** 2026-03-02
**Branch:** `zvadaadam/chat-ui-polish`
**Status:** Investigated, deferred. Ship height animations now, revisit if users report scroll jumping.

---

## Problem

When users click expand/collapse on collapsible sections in the chat (tools, thinking blocks, turns, subagents), the clicked button sometimes stays in place (correct) and sometimes jumps up (broken). This happens even when no agent is streaming.

The user expectation: click a button, the button stays exactly where it is on screen, content expands below it. Click again, button stays, content collapses.

---

## Root Cause

### TanStack Virtual doesn't compensate scrollTop when items resize

Our chat uses TanStack Virtual v3 for virtualization. Items are absolutely positioned with `transform: translateY(startPx)`. When a virtual item's height changes (via ResizeObserver from `measureElement`):

1. The virtualizer recalculates item positions
2. Items below the resized one shift (their `translateY` changes)
3. `getTotalSize()` updates
4. **But `scrollTop` is NOT adjusted** — no code compensates for the layout shift

### The only scrollTop adjustment is for message prepends

In `Chat.tsx`, the `prevTotalSizeRef` useLayoutEffect adjusts `scrollTop += delta` but is gated by `currentFirstSeq < prevFirstSeq` — it only fires when older messages are prepended, not when existing items resize.

### Browser scrollTop clamping on collapse

When collapsing near the bottom of the chat, the total scroll height decreases. If `scrollTop > new (scrollHeight - clientHeight)`, the browser clamps it to the new max, causing a visible jump.

### Chase loop interference (edge case)

The rAF auto-scroll chase loop (`useAutoScroll.ts`) continuously writes `scrollTop` when active. If the chase loop happens to be running during an expand (e.g., within the 167ms idle-stop window after reaching bottom), it chases the new `scrollHeight`, scrolling the viewport down and making the button appear to drift up.

---

## Competitive Analysis

### Cursor (Electron + VS Code)

- **Does virtualize** chat messages — TanStack Virtual bundled directly into `workbench.desktop.main.js` (not an npm dep)
- **Scroll anchoring:** Manual `getBoundingClientRect()` capture before toggle → `setScrollPositionNow()` after layout settles
- Found 623 `scrollTop` references — heavy manual scroll management
- Uses `autoScrollToBottom` + `scrollTrigger` for streaming, separate logic for expand/collapse
- Does NOT use CSS `overflow-anchor`

### Codex (Electron + React)

- **Does NOT virtualize** — standard DOM rendering with React `.map()`
- **Scroll anchoring:** Relies on browser defaults + Tailwind reset (`overflow-anchor: none` from reset only)
- Simpler codebase, works for typical conversation lengths (~100 messages)
- No virtual list libraries in dependencies

### Key Finding

Neither app uses CSS `overflow-anchor: auto` as their primary scroll anchoring mechanism. Cursor does manual scroll compensation (same approach we'd need). Codex avoids the problem entirely by not virtualizing.

---

## TanStack Virtual Built-In Option

TanStack Virtual v3 has `shouldAdjustScrollPositionOnItemSizeChange`:

```typescript
// In @tanstack/virtual-core
shouldAdjustScrollPositionOnItemSizeChange?: (
  item: VirtualItem,
  delta: number,
  instance: Virtualizer
) => boolean
```

**How it works:**

- When `measureElement` detects a height change, it calculates `delta = newSize - oldSize`
- If this callback returns `true` (or if no callback and `item.start < scrollOffset`), the virtualizer calls `this.scrollAdjustments += delta`
- This auto-corrects scroll for items **above** the current viewport

**Default behavior (no callback):** adjusts scroll only when the resized item is above the viewport. This handles the case where you scroll up, something below expands, and the viewport shouldn't shift.

**We're currently NOT using this option.**

---

## Three Approaches Evaluated

### Option A: Enable `shouldAdjustScrollPositionOnItemSizeChange` only

**Change:** 1 line in Chat.tsx virtualizer config.

**Handles:** Items above viewport resizing (streaming content, expand/collapse of off-screen items).

**Doesn't handle:** Items in viewport (the item you're looking at and clicking), near-bottom collapse (browser clamp), chase loop interference.

**Complexity:** Minimal. But insufficient alone.

### Option B: Manual "pin the button" hook (Cursor's approach)

**Implementation:**

1. Create `ChatScrollContext` exposing scroll container ref + `pauseChase()` from useAutoScroll
2. Create `useScrollAnchoredToggle(buttonRef, toggleFn)` hook:
   - Captures `button.getBoundingClientRect().top` before toggle
   - Calls `pauseChase()` to stop the chase loop
   - Calls `toggleFn()` (state change)
   - In rAF after layout: measures new `.top`, adjusts `container.scrollTop += (newTop - oldTop)`
3. Integrate in all 5 collapsible components

**Handles:** ALL cases — above viewport, in viewport, near bottom, chase loop interference.

**Complexity:** ~100 lines new infrastructure (context + hook), changes to 8 files, introduces timing-sensitive rAF coordination between scroll correction and Framer Motion animation.

### Option C: Remove virtualization entirely

**Implementation:** Replace TanStack Virtual with regular DOM rendering. Add `overflow-anchor: auto` to scroll container.

**Handles:** Everything — browser native scroll anchoring works with normal document flow.

**Complexity:** Delete ~100 lines of virtualizer code. But risk: performance degrades at scale (50+ tool calls per session, multiple concurrent sessions). Contradicts performance guidelines.

---

## Recommended Path (Deferred)

**Ship height animations now. Revisit scroll anchoring if users report it.**

The height animations added in this PR (Framer Motion `height: 0 → auto` on all 6 collapsible types) already made expand/collapse feel dramatically better. The scroll jumping is a secondary polish issue that happens sometimes.

If revisiting, implement **Option A + lightweight Option B**:

### Step 1: Enable virtualizer scroll correction

```typescript
// Chat.tsx — useVirtualizer config
const virtualizer = useVirtualizer({
  count: turns.length,
  getScrollElement: () => messagesContainerRef.current,
  estimateSize,
  overscan: 8,
  getItemKey,
  // NEW: auto-correct scroll for items above viewport on resize
  shouldAdjustScrollPositionOnItemSizeChange: (item, delta, instance) => {
    return item.start < instance.scrollOffset + instance.scrollAdjustments;
  },
});
```

### Step 2: Expose pause function from useAutoScroll

```typescript
// useAutoScroll.ts — add to returned API
const pauseChaseTemporarily = useCallback(
  (durationMs = 300) => {
    stopChase();
    isPausedRef.current = true;
    setTimeout(() => {
      isPausedRef.current = false;
      if (isAtBottom(messagesContainerRef.current)) startChase();
    }, durationMs);
  },
  [stopChase, startChase]
);
```

### Step 3: Thread via existing session context

Add `pauseScrollChase` to the `useSession()` context value. No new context needed.

### Step 4: Call in expand/collapse handlers

```typescript
// In each collapsible component's onClick:
const { pauseScrollChase } = useSession();

const handleToggle = () => {
  pauseScrollChase?.(); // pause chase for 300ms
  setIsExpanded(!isExpanded);
};
```

### What this leaves unsolved

The near-bottom collapse case (browser `scrollTop` clamp). This is rare — users typically collapse sections higher up in the chat. If it becomes a real problem, add the full `getBoundingClientRect` pin from Option B.

---

## Files Involved

| File                                                            | Role                                               |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `src/features/session/ui/Chat.tsx`                              | Virtualizer config, scroll container               |
| `src/features/session/hooks/useAutoScroll.ts`                   | Chase loop, scroll manipulation                    |
| `src/features/session/ui/AssistantTurn.tsx`                     | Turn-level collapse                                |
| `src/features/session/ui/MessageItem.tsx`                       | User message collapse                              |
| `src/features/session/ui/blocks/ThinkingBlock.tsx`              | Thinking block collapse                            |
| `src/features/session/ui/blocks/SubagentGroupBlock.tsx`         | Subagent collapse                                  |
| `src/features/session/ui/blocks/ToolGroupBlock.tsx`             | Tool group collapse (already has height animation) |
| `src/features/session/ui/tools/components/BaseToolRenderer.tsx` | All 15+ tool renderers                             |
| `src/features/session/context/SessionContext.tsx`               | Thread pauseScrollChase                            |

---

## References

- TanStack Virtual v3 source: `node_modules/@tanstack/virtual-core/dist/esm/index.js` — search for `shouldAdjustScrollPositionOnItemSizeChange`
- Cursor source: `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`
- Codex source: `/Applications/Codex.app/Contents/Resources/`
- Our auto-scroll: `src/features/session/hooks/useAutoScroll.ts` — rAF chase loop with grace frames and in-loop pause detection
