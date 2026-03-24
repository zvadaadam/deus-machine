---
name: Over-engineering anti-patterns to flag
description: User explicitly wants reviews to catch unnecessary complexity, indirection, and clever-but-harder-to-read patterns
type: feedback
---

Flag anything where a simpler approach achieves the same result. The user has already caught:

1. String-key serialization hack in a Zustand selector (build comma string → split back to Set) instead of `useShallow`
2. A `useEffect` syncing a value into a ref when a callback wrapper was cleaner
3. Pass-through `unreadActions` wrapper that just delegates to `useUnreadStore.getState()` with no added value

**Why:** The user wants to be shown simpler alternatives every time, not just when the code is "wrong". "Could this be 3 lines instead of 10?" is the bar.

**How to apply:**

- For every Zustand selector that returns a derived object or Set, ask: could `useShallow` replace a string-key or useMemo workaround?
- For every `useEffect` that only syncs a value (no async, no side-effect beyond ref update), ask: is this just a render-body assignment?
- For every re-export wrapper file or `Actions` object, ask: does it add anything over direct `getState()` calls?
- For every exported function in a utility file, check it has at least one import site. Dead exports in central files mislead readers.
- Redundant indirection (A calls B which calls C where B adds nothing) should always be flagged.
