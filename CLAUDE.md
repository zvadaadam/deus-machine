# WHAT ARE WE BUILDING?

New IDE to manage multiple parallel AI coding agents at once.

This product is for semi-technical people who want to get the job done. They care more about the job output than the technology and code underneath.

We treat AI chat as a first-class citizen here, code it secondary.


# TechStack

This is a desktop app built with Tauri app.
It runs a backend which communicates with Claude Code CLI.
Also has this small Rust backend which manages it.


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

### Port 1420 already in use
```bash
lsof -ti:1420 | xargs kill -9
npm run dev:full
```

### Check what's running
- Frontend: http://localhost:1420/
- Backend: Dynamic port (check terminal output for "Backend server started on port XXXXX")


# OUR FRONTEND

We want to achieve a beautiful aesthetic design of a pro consumer product.

Design inspiration from Linear, Vercel, Stripe, Airbnb, or Perplexity.


## State Managment
- Using Zustand

## Styling
- Using Tailwind
- Consistent padings default 16px (this product is more dense)
- Consistent font sizes
- Consistent colors (avoid hardcoding colors at all costs)
- Always use font and color tokens from the Tailwind config

## Components
- The base is Shadcn components
- Split into components


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
- When using Motion/Framer Motion use `transform` instead of `x` or `y` if you need animations to be hardware accelerated.
 
### Spring animations
 
- Default to spring animations when using Framer Motion.
- Avoid using bouncy spring animations unless you are working with drag gestures.


## Testing

Test if the backend or frontend works using the browser tool or running tests.

## AVOID AT ALL COST
- Never edit or even modify outside of your worktree directory — it's STRICTLY prohibited.
- Never start this app outside of your worktree directory — it's STRICTLY prohibited.
