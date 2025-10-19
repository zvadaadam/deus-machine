# Vibrancy Architecture Debugging

## Goal
Achieve Arc browser-style transparent sidebar with universal background on `#root`

## What We're Seeing
❌ **Desktop App**: Sidebar has SOLID WHITE background (not transparent)
✅ **Expected**: Sidebar should be transparent, showing #root's background through it

---

## Attempts Made

### 1. ✅ Moved universal background to #root (styles.css:88)
```css
#root {
  @apply min-h-screen w-full m-0 p-0 bg-background transition-colors duration-200;
}
```

### 2. ✅ Removed vibrancy-root from SidebarProvider (Dashboard.tsx:336)
**Before**: `<SidebarProvider className="vibrancy-root">`
**After**: `<SidebarProvider>`

### 3. ✅ Removed backdrop-blur from SidebarProvider (sidebar.tsx:148)
**Before**: `backdrop-blur-[40px] backdrop-saturate-[180%]`
**After**: Removed hardcoded filters

### 4. ✅ Removed all sidebar borders
- Removed from app-sidebar.tsx:76
- Removed from sidebar.tsx:253
- Removed footer border app-sidebar.tsx:121

### 5. ✅ Made Sidebar explicitly transparent (sidebar.tsx:260)
- Added `bg-transparent` to sidebar wrapper

---

## 🎯 ROOT CAUSE FOUND!

### The Problem:
**File**: `src-tauri/tauri.conf.json:33`
- Window is `transparent: true` with `underWindowBackground` effect
- This makes Tauri window transparent to show macOS vibrancy

**File**: `src/styles.css:88`
- `#root` has `bg-background`
- `--background: 0 0% 100%` = WHITE (from line 12)
- This SOLID WHITE covers the Tauri vibrancy!

### The Fix:
For desktop app, `#root` should be **transparent** to let Tauri window effects show through!

---

## Architecture (Target)
```
#root (bg-background)           ← Universal background layer
  ├─ SidebarProvider            ← No background
  │   └─ Sidebar                ← bg-transparent
  │       └─ SidebarContent     ← Should be transparent
  │           └─ WorkspaceItems ← Should be transparent
  ├─ SidebarInset               ← No background
  └─ Main content card          ← bg-white/70 + backdrop-blur-[20px]
```

---

## Next Steps
1. Check CSS variables for sidebar colors
2. Inspect all sidebar child components for backgrounds
3. Check if desktop app has different CSS loading
4. Use browser DevTools in desktop app to find the culprit
