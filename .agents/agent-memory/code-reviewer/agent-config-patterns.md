# Agent Config Feature Patterns

## Dual-Scope Architecture (Confirmed, agent-config-redesign branch)

- Both scopes (project + global) are always fetched and shown. Category views call `useAgentConfigList`
  twice: once with `{ enabled: true }` for global, once with `{ enabled: !!repoPath }` for project.
- `CategoryContentArea` handles scope section layout. Project is labeled with `repoName`, global is
  labeled "Global" (or unlabeled when no project scope). Global items render with `opacity-50` when a
  project scope is active (`dimGlobal = hasProjectScope`).
- `category` prop on `CategoryContentAreaProps` is declared in the interface but intentionally NOT
  destructured in the function body — it exists for future use / documentation. TypeScript does not
  error on unused destructured interface props at the call site. Not a bug.
- `handleCancelAdd` and `handleCancelEdit` are intentional no-ops in `CategoryContentArea`. Category
  views own their own state; the onCancel closure passed to `renderEditForm` closes over the view's
  own setState calls. The `CategoryContentArea` wires up the cancel callback _calls_ but the state
  mutation lives in the category view. The no-op prevents double-clear (the renderEditForm's onCancel
  already clears editingItem/addingInScope in the view).

## AnimatePresence Key Pattern in ScopeSection

- `key={`row-${item.scope}-${item.id}`}` — scoping the key by scope prevents key collisions when the
  same item name appears in both project and global (e.g., a skill named "test" in both). Correct.
- `AnimatePresence mode="popLayout"` in `ScopeSection` wraps all items. When an item is being edited
  (renderEditForm replaces the ConfigItemRow), the row exits with animation and the form enters.
  This requires consistent keys on both the row and the form — the form uses
  `key={isNew ? "add-form" : `edit-${item.scope}-${item.id}`}`. The key change between row
  (`row-{scope}-{id}`) and form (`edit-{scope}-{id}`) correctly triggers the exit/enter transition.

## ConfigItemExpanded Border Class Order

- `border-border/40 border-primary/40 space-y-3 border-b border-l-2` — in Tailwind v4 the last `border-color`
  class wins per twMerge. `border-primary/40` comes after `border-border/40` so the primary color applies
  to ALL borders (top, right, bottom, left), not just the left accent. The `border-b` and `border-l-2`
  control _which sides_ are visible. Visually: bottom border uses primary color, left border uses primary
  color. The intent (only the left uses primary) would require CSS custom properties or separate
  `border-l-[color:...]` class. Minor visual inconsistency but not a bug if primary is close to border.

## text-2xs Token

- `text-2xs` IS a valid token — `--text-2xs: 9px` defined in global.css @theme block. Safe to use.

## HooksView Delete Pattern

- Hooks don't use `useDeleteConfigItem` — they rebuild the full hooks map with the deleted key removed
  and call `useSaveConfigItem`. This is intentional (hooks backend expects full-replace PUT, not per-item
  DELETE). Only `useSaveConfigItem("hooks")` is imported; `useDeleteConfigItem` is NOT imported.

## handleAdd Toggle Guard Bug (Known, scope-redesign branch)

- All 5 category views have the same `handleAdd` pattern:
  `if (addingInScope) { setAddingInScope(null); resetForm(); return; }`
- This toggle guard ignores the `scope` argument entirely — if `addingInScope === "project"` and the
  user selects "Add to Global" from the dropdown, the form is dismissed instead of switched.
  The `scope` argument is only used in the happy path (when `addingInScope` is null/false).
- Fix: replace the toggle guard with a scope-aware check:
  `if (addingInScope === scope) { setAddingInScope(null); resetForm(); return; }`
  This allows switching between project and global add modes without dismissing.

## Index Keys in HooksView Form Loops (Known Issue)

- `formGroups.map((group, gi) => <div key={gi}>)` and `group.commands.map((cmd, ci) => <div key={ci}>)`
  use array index as React key. When a group/command is removed from the middle, React reuses DOM nodes
  in order — controlled Input values shift up by one row (the deleted row's DOM element inherits the
  next row's value on the screen, then React corrects it). This causes a flash/jitter on delete.
  Fix: derive stable keys from content — e.g. `key={`group-${gi}-${group.matcher || gi}`}` or assign
  uuid() at group creation time stored in FormMatcherGroup.

## Number(timeout) NaN Risk in HooksView

- `formGroupsToHandlers` uses `Number(c.timeout)` where `c.timeout` is any user-typed string.
  Guard `c.timeout.trim()` excludes empty string, but `Number("abc")` = NaN is not excluded.
  NaN would be sent as the timeout value to the API. Fix: add `type="number"` on the timeout Input
  and/or validate with `isNaN(Number(c.timeout))` before including the field.
