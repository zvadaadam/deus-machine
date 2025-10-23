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

### General Styling Guidelines
- Consistent paddings default 16px (this product is more dense)
- Consistent font sizes
- Consistent colors (avoid hardcoding colors at all costs)
- Always use font and color tokens from the Tailwind config

## Components

Maximize reusing of Shadcn components. If you want to design something new, explore src/components/ui/ to see if you can use something or build it from these components. They're the atomic components of all the design.

### Shadcn UI - CRITICAL Best Practices

**DO NOT modify core shadcn components directly!** Follow these rules:

#### Never Edit Core Components
- ❌ **NEVER** modify files in `src/components/ui/` created by shadcn CLI
- ❌ Don't change the internal logic, props, or structure of shadcn components
- ❌ Don't add custom functionality directly into shadcn component files
- These are **library components** - treat them as read-only dependencies

#### How to Customize - The Right Way

**1. Use Component Variants (Preferred)**
```tsx
// ✅ CORRECT - Use built-in variants
<Button variant="destructive" size="lg">Delete</Button>
<Badge variant="outline">New</Badge>

// ❌ WRONG - Don't modify button.tsx directly
```

**2. Extend Through Composition**
```tsx
// ✅ CORRECT - Create wrapper components
// src/components/custom/DangerButton.tsx
export function DangerButton({ children, ...props }) {
  return (
    <Button variant="destructive" className="gap-2" {...props}>
      <AlertTriangle className="size-4" />
      {children}
    </Button>
  )
}
```

**3. Use ClassName for Styling**
```tsx
// ✅ CORRECT - Add Tailwind classes via className
<Button className="bg-gradient-to-r from-purple-500 to-pink-500">
  Gradient Button
</Button>

// ❌ WRONG - Don't edit button.tsx to add gradients
```

**4. Create Composite Components**
```tsx
// ✅ CORRECT - Compose shadcn components into new ones
// src/components/custom/ConfirmDialog.tsx
export function ConfirmDialog({ title, message, onConfirm }) {
  return (
    <AlertDialog>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

#### When Components Need Updates
- If shadcn releases updates, reinstall via CLI: `npx shadcn@canary add button --overwrite`
- Your customizations should live in separate files, so reinstalls are safe
- Use version control to review changes before overwriting

#### Project Structure
```
src/
├── components/
│   ├── ui/              ← Shadcn components (DON'T TOUCH)
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   └── ...
│   └── custom/          ← Your custom components (USE THIS)
│       ├── DangerButton.tsx
│       └── ConfirmDialog.tsx
```

#### Why This Matters
- Shadcn components are **not a package** - they're source code copied into your project
- Updates require manual reinstallation via CLI
- Custom changes get lost when you update components
- Composition and variants are the shadcn-recommended patterns
- This approach is from shadcn's official documentation and philosophy

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

## AVOID AT ALL COST
- Never edit or even modify outside of your worktree directory — it's STRICTLY prohibited.
- Never start this app outside of your worktree directory — it's STRICTLY prohibited.
