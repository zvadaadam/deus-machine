# Typography System

## ✅ Proper Tailwind Typography Configuration

Typography is now defined in `tailwind.config.js` following industry best practices (Vercel, Linear, Stripe, Arc).

---

## 📐 Available Sizes

### Display Sizes (Hero Sections)
```tsx
<h1 className="text-display-lg">48px • Bold • -0.02em tracking</h1>
<h1 className="text-display">36px • Bold • -0.01em tracking</h1>
```

### Heading Sizes (Section Headers)
```tsx
<h2 className="text-heading-xl">32px • Semibold • -0.01em tracking</h2>
<h2 className="text-heading-lg">24px • Semibold • -0.005em tracking</h2>
<h3 className="text-heading">20px • Semibold</h3>
<h4 className="text-heading-sm">18px • Semibold</h4>
```

### Body Sizes (Content)
```tsx
<p className="text-body-lg">16px • Normal</p>
<p className="text-body">14px • Normal</p>
<p className="text-body-sm">13px • Normal</p>
```

### Caption Sizes (Labels, Metadata)
```tsx
<span className="text-caption">12px • Normal</span>
<span className="text-caption-sm">11px • Normal</span>
```

---

## ✨ Benefits

### ✅ IntelliSense Autocomplete
```tsx
className="text-hea..." // ← Tab completes to heading options!
```

### ✅ Design System Consistency
All font sizes, line heights, letter spacing, and weights are centralized.

### ✅ Pure Tailwind
No CSS classes needed - works natively with Tailwind's JIT engine.

### ✅ Easy to Override
```tsx
className="text-heading font-normal" // Override weight
className="text-body-lg leading-loose" // Override line-height
```

---

## 🎯 Usage Examples

### Before (Bad - Arbitrary Values)
```tsx
<h1 className="text-[48px] font-bold leading-[1.1] tracking-[-0.02em]">
  Title
</h1>
```
❌ No IntelliSense
❌ No design system
❌ Verbose

### After (Good - Config-Based)
```tsx
<h1 className="text-display-lg">
  Title
</h1>
```
✅ Autocomplete works!
✅ Design system enforced
✅ Clean and concise

---

## 📝 Real-World Examples

### Hero Section
```tsx
<div>
  <h1 className="text-display-lg text-foreground mb-4">
    Welcome to OpenDevs
  </h1>
  <p className="text-body-lg text-muted-foreground max-w-2xl">
    Manage multiple coding agents with ease
  </p>
</div>
```

### Card with Header
```tsx
<div className="card">
  <h3 className="text-heading mb-2">Workspace Details</h3>
  <p className="text-body text-muted-foreground">
    View and manage your active workspaces
  </p>
  <span className="text-caption text-muted-foreground">
    Last updated: 2 hours ago
  </span>
</div>
```

### Empty State
```tsx
<EmptyState
  icon={<FolderOpen />}
  title={<span className="text-heading">No Workspaces</span>}
  description={<span className="text-body-sm">Create a new workspace to get started</span>}
/>
```

---

## 🔧 Customization

To add more sizes or modify existing ones, edit `tailwind.config.js`:

```js
fontSize: {
  'custom-size': ['22px', { lineHeight: '1.4', fontWeight: '500' }],
  // ... rest of sizes
}
```

Then use: `className="text-custom-size"`

---

## 🚀 Migration Guide

### If you have CSS classes:
```css
/* OLD - Delete these */
.my-title { @apply text-[24px] font-semibold; }
```

### Use Tailwind config instead:
```tsx
{/* NEW */}
<h2 className="text-heading-lg">My Title</h2>
```

**This is the modern Tailwind way!** ✨
