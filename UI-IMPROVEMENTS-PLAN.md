# UI Improvements Implementation Plan

## ✅ Completed Fixes

### 1. Backend API 404 Errors - FIXED
- Added missing `/api/workspaces/:id/dev-servers` endpoint
- Returns empty array for now (feature placeholder)
- **File**: [backend/server.cjs:427-435](backend/server.cjs)

### 2. Socket Connection Errors - FIXED
- Added Tauri environment detection
- Graceful fallback for web mode (non-Tauri)
- No more console errors
- **File**: [src/services/socket.ts:15-44](src/services/socket.ts)

---

## 🎨 Design Improvements Needed

### 3. Workspace Header - NEEDS REFACTORING
**Location**: [src/Dashboard.tsx:400-497](src/Dashboard.tsx)

**Current Issues**:
- Inline styles instead of Tailwind
- Old `btn-enhanced` classes instead of shadcn Button
- Poor spacing and visual hierarchy
- Status badges show text instead of using Badge variants properly

**Solution**:
```tsx
// Replace inline styles with Tailwind classes
<div className="border-b border-border p-4">
  <div className="flex items-center justify-between mb-2">
    <div className="flex items-center gap-3">
      {/* Use Tailwind instead of inline style */}
      <h2 className="text-lg font-semibold">
        {selectedWorkspace.directory_name}
      </h2>

      {/* Badges already using shadcn - keep as is */}
      <Badge variant="ready">✓ ready</Badge>
      <Badge variant="working">⚡ working</Badge>
    </div>

    <div className="flex items-center gap-2">
      {/* Replace btn-enhanced with shadcn Button */}
      <Button variant="secondary" size="sm">
        <FileText className="h-4 w-4 mr-1" />
        System Prompt
      </Button>

      <Button variant="secondary" size="sm">
        <Package className="h-4 w-4 mr-1" />
        Compact
      </Button>

      <Button variant="default" size="sm">
        <GitPullRequest className="h-4 w-4 mr-1" />
        Create PR
      </Button>

      <Button variant="destructive" size="sm">
        <Archive className="h-4 w-4 mr-1" />
        Archive
      </Button>
    </div>
  </div>

  {/* Metadata row with Tailwind */}
  <div className="flex items-center gap-3 text-sm text-muted-foreground">
    <span>{selectedWorkspace.repo_name}</span>
    <span>•</span>
    <span>{selectedWorkspace.branch}</span>
  </div>
</div>
```

**Required Changes**:
1. Replace all inline styles with Tailwind classes
2. Replace `btn-enhanced` buttons with shadcn `<Button>` components
3. Use Lucide React icons instead of emojis for buttons
4. Improve spacing with Tailwind gap utilities
5. Use semantic color variables (border-border, text-muted-foreground)

### 4. Empty State - NEEDS SUBTLE IMPROVEMENT
**Location**: [src/Dashboard.tsx:520-525](src/Dashboard.tsx)

**Current State**:
- Uses EmptyState component (already shadcn-compliant)
- Background `bg-secondary/30` might be too prominent

**Solution** (Optional):
- Reduce opacity: `bg-secondary/10`
- OR remove background entirely and use Card instead
- Consider using shadcn Alert for more structure

### 5. File Changes Panel - NEEDS SHADCN COMPONENTS
**Location**: Right sidebar (to be found)

**Current Issues**:
- Custom styling instead of shadcn components
- Missing hover states
- Poor contrast

**Solution**:
- Use shadcn ScrollArea for file list
- Use shadcn Badge for +/- indicators
- Add proper hover states with `@media (hover: hover)`
- Implement active file state with background highlight

### 6. Animation Compliance - NEEDS AUDIT
**CLAUDE.md Requirements**:
- 200-300ms duration
- ease-out timing
- prefers-reduced-motion support

**Files to Check**:
- All transition classes
- Modal animations
- Sidebar animations

---

## 📝 Implementation Priority

### HIGH (Breaks UX)
1. ✅ Fix backend 404 errors
2. ✅ Fix socket connection errors

### MEDIUM (Visual Polish)
3. ⏳ Refactor workspace header (Dashboard.tsx:400-497)
4. ⏳ Use Lucide icons instead of emojis for buttons
5. ⏳ File changes panel styling

### LOW (Nice to Have)
6. Empty state refinement
7. Animation timing audit
8. Accessibility improvements

---

## 🔧 Required Dependencies

Already installed:
- ✅ lucide-react (for icons)
- ✅ @radix-ui/* (shadcn primitives)
- ✅ tailwind-merge + clsx (cn utility)

No new dependencies needed!

---

## 📦 Components to Create/Update

### Update Existing:
1. **Dashboard.tsx** - Workspace header refactor
2. **App.css** - Remove old btn-enhanced styles
3. **WorkspaceDetail.tsx** - If similar issues exist

### Potentially Create:
1. **WorkspaceHeader.tsx** - Extract header into component
2. **FileChangesList.tsx** - Dedicated file changes component

---

## 🎯 Success Criteria

- [ ] Zero console errors ✅ DONE
- [ ] All buttons use shadcn Button component
- [ ] All icons use Lucide React (no emojis in UI controls)
- [ ] All spacing uses Tailwind utilities (no inline styles)
- [ ] All colors use design tokens (hsl variables)
- [ ] Animations follow CLAUDE.md guidelines
- [ ] Build passes with no TypeScript errors
- [ ] Visual hierarchy is clear and consistent
