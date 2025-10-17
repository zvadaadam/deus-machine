# Phase 3: Component Migration Strategy

**Status:** 🟡 Ready to Start
**Date:** 2025-10-17

---

## 🎯 Overview

Phases 1-2 COMPLETE ✅
- Tailwind CSS installed and configured
- shadcn/ui components installed (15+ components)
- Foundation ready

Now we migrate existing components to use Tailwind + shadcn.

---

## 📦 Installed shadcn Components

✅ button, badge, card, skeleton
✅ sidebar (+ separator, sheet, tooltip, input)
✅ dialog, textarea, select, label
✅ scroll-area, tabs
✅ use-mobile hook

---

## 🔄 Migration Order (Step-by-Step)

### Step 1: Migrate Simple UI Components
**Files to update:**
1. `src/components/ui/EmptyState.tsx` - Convert to Tailwind classes
2. Update all imports throughout codebase:
   - `@/components/ui/Button` → `@/components/ui/button` (shadcn)
   - `@/components/ui/Badge` → `@/components/ui/badge` (shadcn)
   - `@/components/ui/Skeleton` → `@/components/ui/skeleton` (shadcn)

### Step 2: Migrate Dashboard Sidebar
**File:** `src/Dashboard.tsx`
- Replace custom sidebar markup with shadcn `Sidebar` component
- Use `SidebarProvider`, `Sidebar`, `SidebarContent`, `SidebarGroup`, etc.
- This is the BIGGEST change - the sidebar component is comprehensive!

### Step 3: Migrate Modals
**Files:**
- `src/features/dashboard/components/NewWorkspaceModal.tsx`
- `src/features/dashboard/components/DiffModal.tsx`
- `src/features/dashboard/components/SystemPromptModal.tsx`

Replace custom modal markup with shadcn `Dialog`:
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
```

### Step 4: Migrate Form Inputs
**Files with forms:**
- Modals (above)
- Settings page
- Any other forms

Replace input/textarea/select with shadcn components:
```tsx
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
```

### Step 5: Migrate Feature Components
**Files:**
- `src/features/dashboard/components/WorkspaceItem.tsx`
- `src/features/dashboard/components/RepoGroup.tsx`
- `src/features/workspace/components/MessageItem.tsx`
- `src/features/workspace/components/MessageList.tsx`
- `src/features/workspace/components/MessageInput.tsx`
- `src/features/workspace/components/FileChangesPanel.tsx`

Convert all CSS classes to Tailwind utilities.

### Step 6: Migrate Large Components
**Files:**
- `src/WorkspaceDetail.tsx`
- `src/Settings.tsx`
- `src/Terminal.tsx`
- `src/TerminalPanel.tsx`
- `src/App.tsx`

Convert all styling to Tailwind.

### Step 7: Cleanup
- Remove old CSS files (11 files)
- Verify animations
- Test build
- End-to-end verification

---

## 🎨 Key Migration Patterns

### Pattern 1: Button Migration
**Before:**
```tsx
<button className="btn-enhanced btn-enhanced-primary">Click</button>
```

**After:**
```tsx
import { Button } from "@/components/ui/button"
<Button variant="default">Click</Button>
```

### Pattern 2: Badge Migration
**Before:**
```tsx
<span className="badge-enhanced badge-enhanced-ready">Ready</span>
```

**After:**
```tsx
import { Badge } from "@/components/ui/badge"
<Badge variant="default">Ready</Badge>
```

### Pattern 3: Modal Migration
**Before:**
```tsx
<div className="modal-overlay">
  <div className="modal">
    <div className="modal-header">...</div>
    <div className="modal-body">...</div>
  </div>
</div>
```

**After:**
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>...</DialogTitle>
    </DialogHeader>
    ...
  </DialogContent>
</Dialog>
```

### Pattern 4: Sidebar Migration
**Before:**
```tsx
<div className="sidebar">
  <div className="sidebar-header">...</div>
  <div className="sidebar-content">...</div>
</div>
```

**After:**
```tsx
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar"
import { SidebarProvider } from "@/components/ui/sidebar"

<SidebarProvider>
  <Sidebar>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>...</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>...</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
</SidebarProvider>
```

---

## ⚠️ Important Notes

1. **Sidebar is the biggest change** - it's a complete component system
2. **Test after each step** - Don't migrate everything at once
3. **Preserve functionality** - Visual changes are OK, but behavior must remain the same
4. **Follow CLAUDE.md** - All animations must be fast (200-300ms), ease-out, transform/opacity only

---

Last Updated: 2025-10-17
