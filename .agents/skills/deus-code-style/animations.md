# Animations

## Project Defaults

- **Default easing:** `ease-out-quart` — `cubic-bezier(.165, .84, .44, 1)`
- **Default duration:** 200-300ms. Never exceed 1s.
- **Hover transitions:** `200ms ease` for color/background/opacity. Disable on touch with `@media (hover: hover) and (pointer: fine)`.
- **Don't use built-in CSS easings** (`ease-out`, `ease-in`) except `ease` for hover and `linear` for constant-speed. Always custom cubic-bezier.

## CSS vs Framer Motion

**CSS/Tailwind** for:
- Hover/focus transitions
- Infinite loops (spinners, shimmers)
- Tooltip/popover enter/exit
- Simple opacity/transform keyframes

**Framer Motion** for:
- Mount/unmount transitions (`AnimatePresence` + `initial`/`animate`/`exit`)
- Layout animations (items shifting after reorder)
- Staggered lists (`staggerChildren`)
- Height auto (CSS can't animate to `auto`)

## Rules

- Animate only `transform` and `opacity` — never width, height, top, left, margin, padding
- `will-change` only for: transform, opacity, clipPath, filter
- No blur above 20px
- Co-locate animation config with the component, not in global.css
- Never define `@keyframes` in global.css for a single component — use Framer Motion inline
- Reuse: `{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }` (ease-out-quart)
- Always wrap conditional renders in `AnimatePresence` when exit animations are needed
