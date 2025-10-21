# Code Quality Improvements

**Status:** Non-blocking enhancements
**Priority:** P2 (Code quality, not functionality)
**Impact:** Improve maintainability and fully complete FSD-Lite migration

## Overview

The FSD-Lite refactoring is functionally complete and the app works correctly. However, there are several code quality improvements that would make the codebase cleaner and more maintainable.

## Issues Identified

### 1. Compatibility Barrels Still in Use

**Status:** Working but not ideal
**Impact:** Low (functionality works, but import paths could be cleaner)

#### Current State
Legacy compatibility barrels exist for backward compatibility:
- `src/hooks/index.ts` - re-exports from `@/shared/hooks`
- `src/hooks/queries/index.ts` - re-exports from feature APIs
- `src/services/index.ts` - re-exports from `@/shared/api`
- `src/utils/index.ts` - re-exports from `@/shared/lib`
- `src/stores/index.ts` - re-exports from feature stores

#### Problem
MainLayout.tsx (and potentially other files) still use these compatibility paths:
```typescript
// Current (compatibility barrel)
import { useKeyboardShortcuts } from "@/hooks";
import { useWorkspaceStore, useUIStore } from "@/stores";
import { ...queries } from "@/hooks/queries";

// Preferred (direct feature imports)
import { useKeyboardShortcuts } from "@/shared/hooks";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { ...queries } from "@/features/workspace/api";
```

#### Recommended Action
1. Search for all imports using `@/hooks`, `@/services`, `@/utils`, `@/stores`
2. Replace with proper FSD paths
3. Remove compatibility barrels
4. Remove obsolete path aliases from tsconfig.json and vite.config.ts

### 2. Platform Abstraction Incomplete

**Status:** Platform layer exists but not fully utilized
**Impact:** Medium (violates FSD architecture principles)

#### Current State
`src/services/socket.ts` directly imports from Tauri:
```typescript
// Line 12
import { invoke } from '@tauri-apps/api/core';
```

#### Problem
- Socket service is in wrong location (`src/services/` instead of `src/platform/`)
- Direct Tauri imports bypass the platform abstraction layer
- Makes it harder to swap out Tauri for other platforms

#### Recommended Action
1. Move `src/services/socket.ts` → `src/platform/socket/`
2. Create platform wrapper for Tauri `invoke`:
   ```typescript
   // src/platform/tauri/invoke.ts
   export const tauriInvoke = async (...) => {
     if (!isTauriEnv) return mockInvoke(...);
     return invoke(...);
   }
   ```
3. Update socket.ts to use platform wrapper
4. Export through `src/platform/index.ts`

### 3. Obsolete Path Aliases

**Status:** Mostly unused but still defined
**Impact:** Low (confusing for developers, no functional impact)

#### Current State
tsconfig.json and vite.config.ts define paths that are no longer needed:
```json
{
  "@/hooks/*": ["src/hooks/*"],     // Use @/shared/hooks instead
  "@/services/*": ["src/services/*"], // Use @/platform or feature APIs
  "@/types/*": ["src/types/*"],       // Use @/shared/types instead
  "@/config/*": ["src/config/*"],     // Use @/shared/config instead
  "@/utils/*": ["src/utils/*"],       // Use @/shared/lib instead
  "@/styles/*": ["src/styles/*"]      // Use @/app/styles instead
}
```

#### Keep These Aliases
```json
{
  "@/*": ["src/*"],                    // Root alias
  "@/app/*": ["src/app/*"],           // App layer
  "@/features/*": ["src/features/*"], // Features layer
  "@/platform/*": ["src/platform/*"], // Platform layer
  "@/shared/*": ["src/shared/*"],     // Shared layer
  "@/components/*": ["src/components/*"] // shadcn/ui components (intentional)
}
```

#### Recommended Action
1. Verify no code uses obsolete aliases (already confirmed - only 1 usage in utils/index.ts itself)
2. Remove obsolete aliases from both files
3. Update any remaining imports

### 4. Legacy Directories

**Status:** Some contain only re-export barrels
**Impact:** Low (adds confusion, minimal disk space)

#### Current State
```
src/
├── components/ui/  ✅ KEEP (shadcn/ui third-party components)
├── hooks/         ⚠️  Contains only compatibility barrels
├── services/      ⚠️  Contains only socket.ts (should move to platform/)
├── stores/        ⚠️  Contains only compatibility barrel
├── styles/        ⚠️  Empty or minimal
└── utils/         ⚠️  Contains only compatibility barrel
```

#### Recommended Action
1. Move `src/services/socket.ts` → `src/platform/socket/`
2. Remove `src/hooks/`, `src/services/`, `src/stores/`, `src/utils/` after fixing imports
3. Keep `src/components/ui/` (shadcn components per plan line 970)
4. Check `src/styles/` - remove if empty or move contents to `src/app/styles/`

## Implementation Plan

### Phase 1: Audit (1 hour)
- [ ] Search codebase for all uses of compatibility barrel imports
- [ ] Create comprehensive list of files to update
- [ ] Verify no build-time dependencies on old paths

### Phase 2: Fix Imports (2-3 hours)
- [ ] Update MainLayout.tsx imports
- [ ] Update any other files using compatibility barrels
- [ ] Test after each batch of changes
- [ ] Verify app still compiles and runs

### Phase 3: Platform Abstraction (2 hours)
- [ ] Create `src/platform/tauri/invoke.ts` wrapper
- [ ] Move socket.ts to platform layer
- [ ] Update socket.ts to use platform wrapper
- [ ] Test Tauri-specific features

### Phase 4: Cleanup (1 hour)
- [ ] Remove compatibility barrel files
- [ ] Remove obsolete path aliases
- [ ] Remove empty legacy directories
- [ ] Update REFACTORING_PROGRESS.md

### Phase 5: Verification (1 hour)
- [ ] Run TypeScript compilation
- [ ] Test all core features
- [ ] Verify no import errors
- [ ] Update documentation

## Files to Modify

### High Priority
1. `src/app/layouts/MainLayout.tsx` - Fix imports (lines 16, 28, 46)
2. `src/services/socket.ts` - Move to platform/ and wrap Tauri imports
3. `tsconfig.json` - Remove obsolete aliases
4. `vite.config.ts` - Remove obsolete aliases

### Medium Priority
5. Search and replace all `from "@/hooks"` imports
6. Search and replace all `from "@/stores"` imports
7. Search and replace all `from "@/hooks/queries"` imports

### Low Priority
8. Remove compatibility barrels: `src/hooks/index.ts`, `src/services/index.ts`, etc.
9. Remove empty directories

## Risk Assessment

**Risk Level:** LOW

- App currently works correctly
- Changes are primarily import path updates
- TypeScript will catch any broken imports
- Can be done incrementally with testing at each step
- No API changes or behavior modifications

## Success Criteria

- [ ] Zero uses of compatibility barrel imports
- [ ] All Tauri APIs accessed through platform layer
- [ ] Only necessary path aliases defined
- [ ] No empty legacy directories
- [ ] TypeScript compiles with 0 errors
- [ ] All features continue to work correctly

## Notes

This is purely a code quality improvement. The refactoring is functionally complete and the app works. These changes would make the codebase cleaner and more maintainable long-term, but are not required for the app to function.

Estimated total time: 6-8 hours for complete implementation and testing.
