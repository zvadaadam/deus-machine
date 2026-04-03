# Tailwind & Styling

## Tailwind CSS v4 — Key Differences

v4 is NOT v3. These are the traps:

- **No JavaScript config.** All config lives in `src/global.css` using `@theme` directive. Never create `tailwind.config.js`.
- **No `@layer`** — `@layer base/components/utilities` is not supported in v4.
- **No `@apply`** — use vanilla CSS instead.
- **No `@theme inline`** — put everything in the main `@theme` block.
- **No `tailwindcss-animate`** — animations are built-in.
- **Vite plugin:** `@tailwindcss/vite` (not `@tailwindcss/postcss`).

### Color System: OKLCH

All colors use OKLCH, not HSL/RGB. Semantic colors in `:root` and `.dark`:

```css
@theme {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --font-family-sans: "Helvetica Neue", -apple-system, ...;
}
```

For semi-transparent: `color-mix(in oklch, var(--primary) 25%, transparent)`.

## What Goes Where

### Global CSS (`src/global.css`) — ONLY:

1. `@theme` block (design tokens)
2. `@keyframes` (GPU-accelerated animations shared across components)
3. Global element styles (`html`, `body`, `#root`, scrollbars)
4. Complex effects Tailwind can't do (vibrancy, backdrop filters, markdown content styling)
5. `@media (prefers-reduced-motion)`, `@media (hover: hover)`

### Never add to global CSS:

Simple utilities that Tailwind already handles — spacing, shadows, typography, layout, colors. If Tailwind does it in 2-3 classes, don't make a custom utility.

### Component variants (`src/components/ui/*`):

Repeated patterns: size variations (`size="sm"`), style variations (`variant="outline"`), state variations (`data-state="active"`).

### Inline Tailwind:

Layout, one-off adjustments, responsive, state variants — the usual.

## Specificity & Overrides

- Never use `!important` — if you need it, the specificity architecture is wrong
- `cn()` / twMerge only merges classes with **identical modifiers**. `has-[>svg]:px-3` and `has-[&>svg]:px-1` coexist instead of overriding. Always match the exact modifier string from the base component.
- When debugging spacing, always read the base component source (`components/ui/*.tsx`) to see what CVA defaults you're inheriting

## Debugging Layout Issues

Before touching CSS:

1. Outline everything: `* { outline: 1px solid rgba(255,0,0,0.3) !important; }` in DevTools
2. Trace the full component tree (parent + element + children across files)
3. Check parent/grandparent for `p-*`, `gap-*`, flex alignment
4. Check compound spacing (parent padding + child margin + flex gap)
5. Read the shadcn base component source for hidden defaults

## General Rules

- All colors via CSS variables/tokens, never hardcoded (`bg-blue-500`, `#3b82f6`)
- Consistent 16px default padding (dense product)
- Use container queries (`@container`) over media queries for reusable components
- Prefer logical properties (`margin-inline`, `padding-block`) for future-proofing
