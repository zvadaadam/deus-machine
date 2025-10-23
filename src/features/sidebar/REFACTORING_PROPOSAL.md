# Sidebar Feature - Refactoring Proposal

## Current Issues

### 1. **Monolithic Component File** (AppSidebar.tsx - 462 lines)
**Problem:** All components, types, and utilities crammed into one file

**Current Structure:**
```
AppSidebar.tsx (462 lines)
├── getRepoInitials() - Helper function
├── getRepoColor() - Helper function
├── Repository interface
├── AppSidebarProps interface
├── AppSidebar component (~100 lines)
├── RepositoryItemProps interface
├── RepositoryItem component (~120 lines)
├── WorkspaceItemProps interface
└── WorkspaceItem component (~150 lines)
```

**Violations:**
- ❌ Single Responsibility Principle
- ❌ Inconsistent with codebase patterns (see `features/repository/ui/`)
- ❌ Hard to navigate and maintain
- ❌ Difficult to test components independently
- ❌ Components can't be reused elsewhere

---

## Proposed Solution

### New Structure (FSD Pattern):

```
features/sidebar/
├── ui/
│   ├── AppSidebar.tsx                    (~80 lines)
│   ├── RepositoryItem.tsx                (~120 lines)
│   ├── WorkspaceItem.tsx                 (~150 lines)
│   ├── SidebarHeader.tsx                 (~40 lines) *new*
│   ├── SidebarFooter.tsx                 (~40 lines) *new*
│   └── index.ts                          (barrel export)
│
├── lib/
│   ├── utils.ts                          (✅ CREATED)
│   │   ├── getRepoInitials()
│   │   └── getRepoColor()
│   └── index.ts
│
├── model/
│   ├── types.ts                          *new*
│   │   ├── Repository
│   │   ├── RepositoryItemProps
│   │   └── WorkspaceItemProps
│   └── index.ts
│
├── store/
│   └── sidebarStore.ts                   (✅ Already good)
│
└── index.ts
```

---

## Benefits

### 1. **Single Responsibility**
Each file does ONE thing:
- `AppSidebar.tsx` → Orchestrates layout
- `RepositoryItem.tsx` → Renders repository + workspaces
- `WorkspaceItem.tsx` → Renders single workspace
- `utils.ts` → Pure utility functions
- `types.ts` → Type definitions

### 2. **Testability**
```ts
// Before: Must import entire AppSidebar to test WorkspaceItem
import { AppSidebar } from '@/features/sidebar'  // ❌ 462 lines imported!

// After: Import only what you need
import { WorkspaceItem } from '@/features/sidebar/ui'  // ✅ 150 lines
```

### 3. **Reusability**
```tsx
// Can now use WorkspaceItem in other contexts
import { WorkspaceItem } from '@/features/sidebar/ui'

// Use in dashboard
<WorkspaceItem workspace={ws} isActive={false} onClick={...} />

// Use in modal
<WorkspaceItem workspace={ws} isActive={true} onClick={...} />
```

### 4. **Consistency**
Matches pattern already used in `features/repository/`:
```
features/repository/ui/
├── WelcomeView.tsx
├── WorkspaceItem.tsx        ← Separate file
├── RepoGroup.tsx            ← Separate file
├── CloneRepositoryModal.tsx ← Separate file
└── NewWorkspaceModal.tsx    ← Separate file
```

### 5. **Better Git History**
```bash
# Before: One file for everything
src/features/sidebar/ui/AppSidebar.tsx    # 50 commits, hard to track

# After: Clear change history
src/features/sidebar/ui/AppSidebar.tsx    # 10 commits (layout changes)
src/features/sidebar/ui/WorkspaceItem.tsx # 15 commits (workspace logic)
src/features/sidebar/ui/RepositoryItem.tsx# 12 commits (repo logic)
```

---

## Migration Steps

### Phase 1: Extract Utilities (✅ DONE)
- [x] Create `lib/utils.ts` with helper functions
- [x] Update imports in AppSidebar.tsx

### Phase 2: Extract Types
- [ ] Create `model/types.ts` with all interfaces
- [ ] Export from `model/index.ts`
- [ ] Update imports

### Phase 3: Extract Components
- [ ] Create `ui/WorkspaceItem.tsx`
- [ ] Create `ui/RepositoryItem.tsx`
- [ ] Create `ui/SidebarHeader.tsx`
- [ ] Create `ui/SidebarFooter.tsx`
- [ ] Simplify `ui/AppSidebar.tsx` to orchestration only

### Phase 4: Barrel Exports
- [ ] Update `ui/index.ts` to export all components
- [ ] Update `features/sidebar/index.ts` for clean public API

---

## Example: Simplified AppSidebar After Refactor

```tsx
// features/sidebar/ui/AppSidebar.tsx
import { Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarMenu } from "@/components/ui/sidebar";
import { SidebarHeaderContent } from "./SidebarHeader";
import { RepositoryItem } from "./RepositoryItem";
import { SidebarFooterContent } from "./SidebarFooter";
import type { AppSidebarProps } from "../model/types";

export function AppSidebar({
  repositories,
  selectedWorkspaceId,
  diffStats,
  onWorkspaceClick,
  onNewWorkspace,
  onArchive,
  onAddRepository,
}: AppSidebarProps) {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeaderContent />

      <SidebarContent className="group-data-[collapsible=icon]:overflow-visible">
        <SidebarMenu className="p-2 gap-2">
          {repositories.map((repo) => (
            <RepositoryItem
              key={repo.repo_id}
              repository={repo}
              selectedWorkspaceId={selectedWorkspaceId}
              diffStats={diffStats}
              onWorkspaceClick={onWorkspaceClick}
              onNewWorkspace={onNewWorkspace}
              onArchive={onArchive}
            />
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooterContent onAddRepository={onAddRepository} />
    </Sidebar>
  );
}
```

**Result:** Clean, focused, ~80 lines instead of 462!

---

## Comparison: Before vs After

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **AppSidebar.tsx** | 462 lines | ~80 lines | ✅ 83% smaller |
| **Files in ui/** | 1 file | 5 files | ✅ Better organization |
| **Test granularity** | All or nothing | Per component | ✅ Easier testing |
| **Import size** | 462 lines | ~150 lines max | ✅ Smaller bundles |
| **Reusability** | Trapped | Composable | ✅ Can reuse anywhere |
| **Code review** | Large diffs | Small focused diffs | ✅ Easier review |

---

## Antipatterns Avoided

### ❌ God Object/Component
**Before:** AppSidebar knows everything, does everything
**After:** Single-purpose components

### ❌ Tight Coupling
**Before:** Can't use WorkspaceItem without AppSidebar
**After:** All components are independent

### ❌ Violation of DRY
**Before:** Can't reuse RepositoryItem elsewhere (must copy-paste)
**After:** Import and use anywhere

### ❌ Testing Pyramid Inversion
**Before:** Must test entire AppSidebar (integration test)
**After:** Can unit test each component separately

---

## Next Steps

1. **Review this proposal** with team
2. **Create feature branch**: `refactor/sidebar-component-extraction`
3. **Extract one component** at a time (start with WorkspaceItem)
4. **Test after each extraction** to ensure no regressions
5. **Update documentation** as you go

---

## Questions to Consider

1. Should `SidebarHeader` and `SidebarFooter` be separate components or stay in AppSidebar?
2. Should we create a `ui/components/` subdirectory for smaller components?
3. Do we need a `hooks/` directory for custom hooks (e.g., `useRepositoryExpansion`)?
4. Should types live in `model/` or colocate with components?

---

## References

- [Feature-Sliced Design](https://feature-sliced.design/)
- [Component Composition Patterns](https://kentcdodds.com/blog/compound-components-with-react-hooks)
- [SOLID Principles for React](https://konstantinlebedev.com/solid-in-react/)
