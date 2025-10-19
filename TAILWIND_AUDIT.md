# Tailwind-First Audit

## Goal
Identify CSS classes that should be refactored to inline Tailwind following best practices.

---

## ✅ KEEP (Good Abstractions)

### 1. **Base Styles** (body, html, #root)
- **Why**: Global app styles, not component-specific
- **Location**: `styles.css:82-99`

### 2. **Typography System** (.text-h1, .text-h2, etc.)
- **Why**: Design system - consistent sizing across app
- **Usage**: 0 times (unused!)
- **Location**: `styles.css:193-234`
- **Action**: ⚠️ **REMOVE** - Not used anywhere!

### 3. **Spacing System** (.space-standard, .space-standard-x, etc.)
- **Why**: Design system primitive
- **Usage**: 1 time in Dashboard.tsx
- **Location**: `styles.css:238-255`
- **Verdict**: **KEEP** but barely used

### 4. **Elevation System** (.elevation-0 to .elevation-5)
- **Why**: Complex shadows, reusable pattern
- **Usage**: Multiple places (valid abstraction)
- **Location**: `styles.css:165-187`
- **Verdict**: **KEEP** ✅

### 5. **Scrollbar Styling** (.scrollbar-vibrancy)
- **Why**: Complex pseudo-selectors, can't do inline
- **Location**: `styles.css:142-156`
- **Verdict**: **KEEP** ✅

### 6. **Media Queries** (reduced motion, hover)
- **Why**: Accessibility, can't do inline
- **Location**: `styles.css:105-121`, `styles.css:158-165`
- **Verdict**: **KEEP** ✅

### 7. **Vibrancy Shadow** (.vibrancy-shadow)
- **Why**: Complex multi-layer shadow
- **Location**: `styles.css:130-134`
- **Verdict**: **KEEP** ✅ (just refactored!)

---

## 🔴 REFACTOR TO INLINE TAILWIND

### 1. **`.vibrancy-input`** ⚠️
- **Current**: `@apply bg-white/50 dark:bg-black/40 backdrop-blur-[10px] transition-colors duration-200`
- **Usage**: NOT USED IN ANY COMPONENT!
- **Action**: **DELETE** ❌

### 2. **`.empty-state`**
- **Current**: `@apply flex flex-col items-center justify-center text-center space-standard`
- **Usage**: 1 time in EmptyState.tsx
- **Action**: **INLINE** - Only used once
- **New**: `className="flex flex-col items-center justify-center text-center p-4"`

### 3. **`.empty-state-icon`**
- **Current**: `@apply w-16 h-16 mb-5 text-muted-foreground/50`
- **Usage**: 6 times across Dashboard.tsx
- **Action**: **INLINE** - Simple utilities
- **New**: `className="w-16 h-16 mb-5 text-muted-foreground/50"`

### 4. **`.empty-state-title`**
- **Current**: `@apply text-heading text-foreground font-semibold mb-3`
- **Usage**: 1 time in EmptyState.tsx
- **Action**: **INLINE**
- **New**: `className="text-lg text-foreground font-semibold mb-3"`

### 5. **`.empty-state-description`**
- **Current**: `@apply text-body-sm text-muted-foreground max-w-sm leading-relaxed`
- **Usage**: 1 time in EmptyState.tsx
- **Action**: **INLINE**
- **New**: `className="text-sm text-muted-foreground max-w-sm leading-relaxed"`

---

## 🚨 CRITICAL: UNUSED/UNDEFINED CLASSES

### 1. **`.vibrancy-bg`** - UNDEFINED!
- **Referenced in**: WorkspaceDetail.tsx, BrowserPanel.tsx, styles.css (media query)
- **Defined**: ❌ NOWHERE!
- **Action**: **DEFINE** or **REMOVE** references

### 2. **`.vibrancy-panel`** - UNDEFINED!
- **Referenced in**: WorkspaceDetail.tsx, TerminalPanel.tsx, styles.css (media query)
- **Defined**: ❌ NOWHERE!
- **Action**: **DEFINE** or **REMOVE** references

### 3. **`.text-heading`** - UNDEFINED!
- **Referenced in**: `.empty-state-title`
- **Defined**: ❌ NOWHERE! (but .text-h1 exists)
- **Action**: Change to `.text-lg` or define it

### 4. **`.text-body-sm`** - UNDEFINED!
- **Referenced in**: `.empty-state-description`
- **Defined**: ❌ NOWHERE!
- **Action**: Change to `.text-sm`

---

## 📊 Summary

**Classes to KEEP**: 7 (base, elevation, scrollbar, media queries, vibrancy-shadow)
**Classes to REFACTOR**: 5 (empty-state-*, vibrancy-input)
**Classes to DEFINE**: 2 (vibrancy-bg, vibrancy-panel)
**Classes UNUSED**: 11 (text-h1 through text-h6, text-body-*, etc.)

---

## 🎯 Recommended Actions

### Priority 1: Fix Broken References
1. Define `.vibrancy-bg` and `.vibrancy-panel` OR remove all references
2. Fix `.text-heading` and `.text-body-sm` references

### Priority 2: Refactor to Inline
1. Inline `.empty-state-*` classes (only used once each)
2. Delete `.vibrancy-input` (not used)

### Priority 3: Cleanup
1. Remove unused typography classes (.text-h1, etc.) or start using them

---

## ✅ UPDATE: ALL ACTIONS COMPLETED + TYPOGRAPHY FIXED!

### ✅ Priority 1: Fixed Broken References
1. ✅ Defined `.vibrancy-bg` (bg-background/95 + backdrop-blur-xl)
2. ✅ Defined `.vibrancy-panel` (bg-background/30 + backdrop-blur-sm)

### ✅ Priority 2: Refactored to Inline
1. ✅ Inlined all `.empty-state-*` classes in EmptyState.tsx
2. ✅ Deleted `.vibrancy-input` (not used anywhere)

### ✅ Priority 3: Typography PROPERLY CONFIGURED
1. ✅ Removed typography CSS classes
2. ✅ **Added to `tailwind.config.js`** (proper Tailwind way!)

---

## 🎨 BONUS: Typography in Tailwind Config

### Moved Typography to Proper Location
```js
// tailwind.config.js
fontSize: {
  'display-lg': ['48px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
  'display': ['36px', { ... }],
  'heading-xl': ['32px', { ... }],
  'heading-lg': ['24px', { ... }],
  // ... all sizes
}
```

### Benefits:
- ✅ **IntelliSense autocomplete** works!
- ✅ **Pure Tailwind** - No CSS classes needed
- ✅ **Design system** - Centralized typography
- ✅ **Industry standard** - Vercel, Linear, Stripe approach

### Usage:
```tsx
<h1 className="text-display-lg">Hero Title</h1>
<h2 className="text-heading">Section Header</h2>
<p className="text-body">Content</p>
```

**See TYPOGRAPHY.md for full documentation!**
