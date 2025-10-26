# Styling Guide

**Last Updated:** 2025-10-26

## Philosophy

- Use semantic tokens, not arbitrary values
- Follow CLAUDE.md animation guidelines (200ms, ease-out)
- This product is **dense** - default to `p-4` (16px)
- Extend existing patterns (chatTheme), don't reinvent

---

## Quick Reference

### Colors

✅ **DO:**
```tsx
text-foreground
bg-primary
border-border
text-muted-foreground
bg-success/10
```

❌ **DON'T:**
```tsx
text-[#333]
bg-[#f0f0f0]
border-[rgba(0,0,0,0.1)]
```

**System:** OKLCH color space (perceptually uniform)
- Defined in `global.css:231-327`
- Automatic dark mode via CSS variables

---

### Typography

| Token | Size | Usage |
|-------|------|-------|
| `text-2xs` | 10px | Tiny labels, badges |
| `text-xs` | 11px | Small labels, captions |
| `text-sm` | 13px | Secondary text |
| `text-base` | 14px | **Default body text** |
| `text-lg` | 16px | Large body text |
| `text-xl` | 20px | Headings |
| `text-2xl` | 24px | Page titles |

**Migration:**
```tsx
// Old → New
text-[10px] → text-2xs
text-[11px] → text-xs
text-[13px] → text-sm
```

---

### Spacing

**Default:** `p-4` (16px) - this product is dense

| Class | Value | Usage |
|-------|-------|-------|
| `p-2` | 8px | Tight spacing (buttons, compact UI) |
| `p-4` | 16px | **Standard** (most elements) |
| `p-6` | 24px | Comfortable (main containers) |
| `p-8` | 32px | Spacious (welcome screens) |

**Gaps:**
```tsx
gap-1   // 4px - tight
gap-2   // 8px - standard for flex/grid children
gap-4   // 16px - generous
```

---

### Transitions

✅ **DO:**
```tsx
// Use utility classes (recommended for consistency)
className="hover-transition"
className="hover-interactive"
className="transition-colors-default"  // Standard color transition (24 uses)

// Or inline Tailwind (acceptable for clarity)
transition-colors duration-200 ease-out motion-reduce:transition-none
```

❌ **DON'T:**
```tsx
// Never use default easings
transition duration-300 ease-in-out ❌

// Never forget motion-reduce
transition-colors duration-200 ❌
```

**Easings (from CLAUDE.md):**
- `ease-out` - Best for entering elements (cubic-bezier(0.25, 0.46, 0.45, 0.94))
- `ease-in-out` - For moving within screen
- `ease` or `linear` - Simple hovers only

**Durations:**
- 200ms - Default for colors, opacity
- 300ms - Transforms, complex animations
- Max 1s - Never exceed unless illustrative

---

### Hover States

✅ **Use utility classes:**

```tsx
// Interactive background + elevation
className="hover-interactive hover:elevation-2"

// Primary text color on hover
className="hover-primary-text"

// Simple transition (exists but prefer hover-interactive)
className="hover-transition"
```

**Defined in:** `global.css:385-400`

❌ **DON'T write this:**
```tsx
[@media(hover:hover)and(pointer:fine)]:hover:bg-sidebar-accent/60
[@media(hover:hover)and(pointer:fine)]:transition-colors
[@media(hover:hover)and(pointer:fine)]:duration-200
```

---

### Common Patterns

#### Scrollable Container (CRITICAL!)
```tsx
{/* Parent MUST have overflow-hidden */}
<div className="flex flex-col h-full overflow-hidden">
  {/* Child MUST have min-h-0 */}
  <div className="flex-1 overflow-y-auto min-h-0">
    {/* scrollable content */}
  </div>
</div>
```

**Why `min-h-0`?** Flex children with `flex-1` ignore parent height without it.

#### Glass Morphism (Vibrancy)
```tsx
{/* Heavy blur - modals, dialogs */}
className="vibrancy-bg"

{/* Medium blur - panels, sections */}
className="vibrancy-panel"

{/* Light blur - custom */}
className="bg-background/50 backdrop-blur-sm"
```

#### Interactive Item
```tsx
<div className="hover-interactive hover:elevation-2 cursor-pointer rounded-lg p-2.5">
  <div className="hover-primary-text">{item.name}</div>
</div>
```

---

## Theme System

### chatTheme Object (Gold Standard)

**Location:** `src/features/session/ui/theme/chatTheme.ts`

```tsx
import { chatTheme } from '@/features/session/ui/theme';

<div className={chatTheme.transition.colors}>
<div className={chatTheme.spacing.standard}>
<div className={chatTheme.blocks.tool.container}>
```

**Benefits:**
- Autocomplete in IDE
- Single source of truth
- Type-safe with TypeScript

**Extend this pattern to other features!**

---

## Anti-Patterns

### ❌ Hardcoded Colors
```tsx
bg-[#1e1e1e]  // Use: bg-muted
text-[#888]   // Use: text-muted-foreground
```

### ❌ Arbitrary Font Sizes
```tsx
text-[14px]   // Use: text-base
text-[0.85rem] // Use: text-sm
```

### ❌ Missing overflow constraints
```tsx
<div className="flex-1 overflow-y-auto">  // Add: min-h-0
```

### ❌ Long media queries
```tsx
[@media(hover:hover)and(pointer:fine)]:hover:...  // Use: hover-interactive
```

### ❌ Forgetting motion-reduce
```tsx
transition-colors duration-200  // Add: motion-reduce:transition-none
```

---

## File Organization

```
src/
├── global.css           ← Theme tokens, utilities
├── features/
│   └── session/
│       └── ui/
│           └── theme/
│               └── chatTheme.ts  ← Feature theme (extend this pattern!)
└── components/
    └── ui/              ← shadcn (DON'T TOUCH!)
```

---

## Migration Guide

When updating old components:

1. **Fix overflow bugs first** (add `overflow-hidden` + `min-h-0`)
2. **Replace media query monsters** with `hover-interactive`
3. **Use semantic color tokens** (text-foreground, not text-[#333])
4. **Add motion-reduce** to transitions
5. **Use typography scale** (text-2xs, not text-[10px])

**Don't refactor everything at once!** Update files as you touch them.

---

## Resources

- **CLAUDE.md** - Animation guidelines, easing functions
- **chatTheme.ts** - Example of good theme object pattern
- **global.css** - All theme tokens and utilities
- **REFACTOR_PROGRESS.md** - Track what's been updated

---

## Questions?

Check existing patterns first:
1. Look at `chatTheme.ts` for similar use cases
2. Search `global.css` for existing utilities
3. Check this guide for common patterns

If unsure, ask before creating new abstractions!
