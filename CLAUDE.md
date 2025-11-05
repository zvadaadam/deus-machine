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

## State Managment
- Using Zustand
- Follow best practicies of using Zustant state managment

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
  --font-family-sans: 'Helvetica Neue', -apple-system, ...;
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
    "config": "",  // Empty - no JS config in v4
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

#### **Component Variants (src/components/ui/*) - Use For:**

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
│   ├── ui/              ← Shadcn base components (EDIT FREELY)
│   │   ├── button.tsx   ← Add variants, change defaults
│   │   ├── badge.tsx    ← Adjust colors, add shapes
│   │   └── ...
│   └── custom/          ← App-specific compositions
│       ├── DangerButton.tsx      ← Product-specific variants
│       └── ConfirmDialog.tsx     ← Domain patterns
```

#### Real Examples from This Project

**✅ sidebar.tsx** - Modified animation timing globally (duration-[180ms] instead of default)
**✅ avatar.tsx** - Could add `shape` variant for `rounded-[8px]` squares vs `rounded-full` circles
**❌ SidebarHeader.tsx** - Currently uses className override `rounded-[8px]` - should edit avatar.tsx instead

### General Component Guidelines
- Split functionality into reusable components
- Follow single responsibility principle
- Keep component files focused and maintainable


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

## AVOID AT ALL COST
- Never edit or even modify outside of your worktree directory — it's STRICTLY prohibited.
- Never start this app outside of your worktree directory — it's STRICTLY prohibited.
