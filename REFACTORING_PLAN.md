# 📋 COMPREHENSIVE REFACTORING ACTION PLAN

**Date:** 2025-10-21
**Branch:** zvadaadam/walla-walla → src-structure-refactor
**Total Files:** 141 files
**Estimated Changes:** ~150+ file operations (moves, renames, deletions, updates)

---

## 🎯 PART 1: FINAL STRUCTURE OVERVIEW

```
src/
├── app/
│   ├── layouts/
│   │   ├── Dashboard.tsx                      [REFACTOR from src/Dashboard.tsx]
│   │   └── components/
│   │       └── WorkspaceHeader.tsx            [CREATE NEW - extract from Dashboard]
│   ├── providers/
│   │   ├── QueryProvider.tsx                  [CREATE NEW - extract from App.tsx]
│   │   └── ThemeProvider.tsx                  [MOVE from hooks/useTheme.tsx + refactor]
│   ├── config/
│   │   └── api.config.ts                      [MOVE from config/api.config.ts]
│   ├── App.tsx                                [KEEP - simplify]
│   └── main.tsx                               [KEEP]
│
├── features/
│   ├── workspace-sidebar/
│   │   └── ui/
│   │       └── Sidebar.tsx                    [MOVE from components/app-sidebar.tsx]
│   │
│   ├── welcome/
│   │   └── ui/
│   │       ├── WelcomeView.tsx                [MOVE from features/dashboard/components/]
│   │       ├── NewWorkspaceModal.tsx          [MOVE from features/dashboard/components/]
│   │       ├── CloneRepositoryModal.tsx       [MOVE from features/dashboard/components/]
│   │       ├── RepoGroup.tsx                  [MOVE from features/dashboard/components/]
│   │       ├── WorkspaceItem.tsx              [MOVE from features/dashboard/components/]
│   │       └── index.ts                       [CREATE NEW]
│   │
│   ├── chat/                                  [RENAME from workspace]
│   │   ├── ui/
│   │   │   ├── ChatPanel.tsx                  [RENAME from WorkspaceChatPanel.tsx]
│   │   │   ├── Chat.tsx                       [MOVE from features/workspace/components/]
│   │   │   ├── MessageInput.tsx               [MOVE from features/workspace/components/]
│   │   │   ├── MessageItem.tsx                [MOVE from features/workspace/components/]
│   │   │   ├── DiffModal.tsx                  [MOVE from features/dashboard/components/]
│   │   │   ├── SystemPromptModal.tsx          [MOVE from features/dashboard/components/]
│   │   │   └── chat/                          [MOVE entire nested structure]
│   │   ├── api/
│   │   │   └── useSessionQueries.ts           [MOVE from hooks/queries/]
│   │   ├── hooks/
│   │   │   └── useAutoScroll.ts               [MOVE from hooks/]
│   │   └── index.ts                           [CREATE NEW]
│   │
│   ├── file-changes/
│   │   ├── ui/
│   │   │   └── FileChangesPanel.tsx           [EXTRACT from Dashboard.tsx lines 600-678]
│   │   └── index.ts                           [CREATE NEW]
│   │
│   ├── browser/
│   │   ├── ui/
│   │   │   └── BrowserPanel.tsx               [MOVE from features/browser/components/]
│   │   ├── api/                               [RENAME from hooks/]
│   │   │   └── useDevBrowser.ts               [MOVE from features/browser/hooks/]
│   │   └── index.ts                           [UPDATE existing]
│   │
│   ├── terminal/
│   │   ├── ui/
│   │   │   ├── TerminalPanel.tsx              [MOVE from src/]
│   │   │   ├── Terminal.tsx                   [MOVE from src/]
│   │   │   └── Terminal.css                   [MOVE from src/]
│   │   └── index.ts                           [CREATE NEW]
│   │
│   └── settings/
│       ├── ui/
│       │   ├── SettingsModal.tsx              [MOVE from features/dashboard/components/]
│       │   └── settings-sections/             [MOVE entire folder]
│       ├── api/
│       │   └── useSettingsQueries.ts          [MOVE from hooks/queries/]
│       └── index.ts                           [CREATE NEW]
│
├── shared/
│   ├── api/
│   │   ├── client.ts                          [RENAME from services/api.ts]
│   │   ├── socket.ts                          [MOVE from services/]
│   │   ├── queries/
│   │   │   ├── useWorkspaceQueries.ts         [MOVE from hooks/queries/]
│   │   │   ├── useRepoQueries.ts              [MOVE from hooks/queries/]
│   │   │   └── index.ts                       [CREATE NEW]
│   │   └── services/
│   │       ├── workspace.service.ts           [MOVE from services/]
│   │       ├── repo.service.ts                [MOVE from services/]
│   │       ├── session.service.ts             [MOVE from services/]
│   │       ├── settings.service.ts            [MOVE from services/]
│   │       ├── memory.service.ts              [MOVE from services/]
│   │       └── index.ts                       [MOVE from services/]
│   │
│   ├── components/
│   │   ├── BranchName.tsx                     [MOVE from components/]
│   │   ├── OpenInDropdown.tsx                 [MOVE from components/]
│   │   ├── ErrorBoundary.tsx                  [MOVE from components/]
│   │   ├── content/                           [MOVE from components/]
│   │   │   └── empty-state.tsx
│   │   ├── error-fallbacks/                   [MOVE from components/]
│   │   │   ├── DashboardError.tsx
│   │   │   └── index.ts
│   │   └── index.ts                           [CREATE NEW]
│   │
│   ├── hooks/
│   │   ├── useSocket.ts                       [MOVE from hooks/]
│   │   ├── useKeyboardShortcuts.ts            [MOVE from hooks/]
│   │   ├── use-mobile.tsx                     [MOVE from hooks/]
│   │   └── index.ts                           [UPDATE from hooks/]
│   │
│   ├── stores/
│   │   ├── workspaceStore.ts                  [MOVE from stores/]
│   │   ├── uiStore.ts                         [MOVE from stores/]
│   │   └── index.ts                           [MOVE from stores/]
│   │
│   ├── types/
│   │   ├── api.types.ts                       [MOVE from types/]
│   │   ├── github.types.ts                    [MOVE from types/]
│   │   ├── repo.types.ts                      [MOVE from types/]
│   │   ├── session.types.ts                   [MOVE from types/]
│   │   ├── settings.types.ts                  [MOVE from types/]
│   │   ├── workspace.types.ts                 [MOVE from types/]
│   │   └── index.ts                           [MOVE from types/]
│   │
│   └── lib/
│       ├── queryClient.ts                     [MOVE from lib/]
│       ├── queryKeys.ts                       [MOVE from lib/]
│       ├── utils.ts                           [MOVE from lib/]
│       ├── formatters.ts                      [MOVE from utils/]
│       └── index.ts                           [CREATE NEW]
│
├── components/
│   └── ui/                                    [KEEP - shadcn components]
│
└── styles/
    ├── styles.css                             [KEEP]
    └── fonts.css                              [KEEP]
```

---

## 📁 PART 2: DETAILED FILE MIGRATION MAP

### **A. FILES TO DELETE** (9 files)

```bash
# Old hooks replaced by TanStack Query
src/hooks/useDashboardData.ts
src/hooks/useWorkspaces.ts
src/hooks/useDiffStats.ts
src/hooks/useFileChanges.ts
src/hooks/useMessages.ts

# Empty directories will be removed after migration
src/config/                    # After moving api.config.ts
src/services/                  # After moving all services
src/stores/                    # After moving all stores
src/types/                     # After moving all types
src/utils/                     # After moving all utils
src/lib/                       # After moving all lib files
```

### **B. ROOT LEVEL FILES** (7 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/App.tsx` | `src/app/App.tsx` | MOVE + REFACTOR (simplify) |
| `src/main.tsx` | `src/app/main.tsx` | MOVE + UPDATE imports |
| `src/Dashboard.tsx` | `src/app/layouts/Dashboard.tsx` | MOVE + MAJOR REFACTOR |
| `src/WorkspaceChatPanel.tsx` | `src/features/chat/ui/ChatPanel.tsx` | MOVE + RENAME + REFACTOR |
| `src/TerminalPanel.tsx` | `src/features/terminal/ui/TerminalPanel.tsx` | MOVE |
| `src/Terminal.tsx` | `src/features/terminal/ui/Terminal.tsx` | MOVE |
| `src/Terminal.css` | `src/features/terminal/ui/Terminal.css` | MOVE |

### **C. CONFIG FILES** (1 file)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/config/api.config.ts` | `src/app/config/api.config.ts` | MOVE + UPDATE imports |

### **D. COMPONENTS** (8 files + folders)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/components/app-sidebar.tsx` | `src/features/workspace-sidebar/ui/Sidebar.tsx` | MOVE + RENAME |
| `src/components/BranchName.tsx` | `src/shared/components/BranchName.tsx` | MOVE |
| `src/components/OpenInDropdown.tsx` | `src/shared/components/OpenInDropdown.tsx` | MOVE |
| `src/components/ErrorBoundary.tsx` | `src/shared/components/ErrorBoundary.tsx` | MOVE |
| `src/components/content/` | `src/shared/components/content/` | MOVE (entire folder) |
| `src/components/error-fallbacks/` | `src/shared/components/error-fallbacks/` | MOVE (entire folder) |
| `src/components/ui/` | `src/components/ui/` | KEEP (no change) |

### **E. FEATURES - WORKSPACE → CHAT** (31 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/features/workspace/components/Chat.tsx` | `src/features/chat/ui/Chat.tsx` | MOVE |
| `src/features/workspace/components/MessageInput.tsx` | `src/features/chat/ui/MessageInput.tsx` | MOVE |
| `src/features/workspace/components/MessageItem.tsx` | `src/features/chat/ui/MessageItem.tsx` | MOVE |
| `src/features/workspace/components/FileChangesPanel.tsx` | `src/features/chat/ui/FileChangesPanel.tsx` | MOVE (used in modal view) |
| `src/features/workspace/components/chat/` | `src/features/chat/ui/chat/` | MOVE (entire nested structure - 26 files) |
| `src/features/workspace/components/index.ts` | `src/features/chat/ui/index.ts` | MOVE + UPDATE |

**Nested chat/ structure (26 files):**
```
src/features/chat/ui/chat/
├── blocks/
│   ├── BlockRenderer.tsx
│   ├── TextBlock.tsx
│   ├── ThinkingBlock.tsx
│   ├── ToolResultBlock.tsx
│   ├── ToolUseBlock.tsx
│   └── index.ts
├── message/
│   ├── MessageItem.tsx
│   └── index.ts
├── theme/
│   ├── chatTheme.ts
│   └── index.ts
├── tools/
│   ├── ToolRegistry.tsx
│   ├── registerTools.ts
│   ├── types.ts
│   ├── index.ts
│   ├── components/
│   │   ├── CodeBlock.tsx
│   │   ├── CopyButton.tsx
│   │   ├── FilePathDisplay.tsx
│   │   ├── SyntaxHighlighter.tsx
│   │   └── index.ts
│   ├── renderers/ (15 files)
│   │   ├── BashOutputToolRenderer.tsx
│   │   ├── BashToolRenderer.tsx
│   │   ├── DefaultToolRenderer.tsx
│   │   ├── EditToolRenderer.tsx
│   │   ├── GlobToolRenderer.tsx
│   │   ├── GrepToolRenderer.tsx
│   │   ├── KillShellToolRenderer.tsx
│   │   ├── LSToolRenderer.tsx
│   │   ├── MultiEditToolRenderer.tsx
│   │   ├── ReadToolRenderer.tsx
│   │   ├── TaskToolRenderer.tsx
│   │   ├── TodoWriteToolRenderer.tsx
│   │   ├── WebFetchToolRenderer.tsx
│   │   ├── WebSearchToolRenderer.tsx
│   │   ├── WriteToolRenderer.tsx
│   │   └── index.ts
│   └── utils/
│       └── detectLanguage.ts
├── types.ts
└── index.ts
```

### **F. FEATURES - DASHBOARD** (14 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/features/dashboard/components/WelcomeView.tsx` | `src/features/welcome/ui/WelcomeView.tsx` | MOVE |
| `src/features/dashboard/components/NewWorkspaceModal.tsx` | `src/features/welcome/ui/NewWorkspaceModal.tsx` | MOVE |
| `src/features/dashboard/components/CloneRepositoryModal.tsx` | `src/features/welcome/ui/CloneRepositoryModal.tsx` | MOVE |
| `src/features/dashboard/components/RepoGroup.tsx` | `src/features/welcome/ui/RepoGroup.tsx` | MOVE |
| `src/features/dashboard/components/WorkspaceItem.tsx` | `src/features/welcome/ui/WorkspaceItem.tsx` | MOVE |
| `src/features/dashboard/components/DiffModal.tsx` | `src/features/chat/ui/DiffModal.tsx` | MOVE |
| `src/features/dashboard/components/SystemPromptModal.tsx` | `src/features/chat/ui/SystemPromptModal.tsx` | MOVE |
| `src/features/dashboard/components/SettingsModal.tsx` | `src/features/settings/ui/SettingsModal.tsx` | MOVE |
| `src/features/dashboard/components/settings-sections/` | `src/features/settings/ui/settings-sections/` | MOVE (entire folder - 7 files) |
| `src/features/dashboard/components/index.ts` | DELETE | - |

### **G. FEATURES - BROWSER** (3 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/features/browser/components/BrowserPanel.tsx` | `src/features/browser/ui/BrowserPanel.tsx` | MOVE |
| `src/features/browser/components/index.ts` | `src/features/browser/ui/index.ts` | MOVE + UPDATE |
| `src/features/browser/hooks/useDevBrowser.ts` | `src/features/browser/api/useDevBrowser.ts` | MOVE |

### **H. HOOKS** (16 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| **DELETE** | | |
| `src/hooks/useDashboardData.ts` | DELETE | Replaced by TanStack Query |
| `src/hooks/useWorkspaces.ts` | DELETE | Replaced by TanStack Query |
| `src/hooks/useDiffStats.ts` | DELETE | Replaced by TanStack Query |
| `src/hooks/useFileChanges.ts` | DELETE | Replaced by TanStack Query |
| `src/hooks/useMessages.ts` | DELETE | Replaced by TanStack Query |
| **MOVE TO FEATURES** | | |
| `src/hooks/useAutoScroll.ts` | `src/features/chat/hooks/useAutoScroll.ts` | MOVE (chat-specific) |
| **MOVE TO SHARED** | | |
| `src/hooks/useSocket.ts` | `src/shared/hooks/useSocket.ts` | MOVE |
| `src/hooks/useKeyboardShortcuts.ts` | `src/shared/hooks/useKeyboardShortcuts.ts` | MOVE |
| `src/hooks/use-mobile.tsx` | `src/shared/hooks/use-mobile.tsx` | MOVE |
| **EXTRACT TO PROVIDER** | | |
| `src/hooks/useTheme.tsx` | `src/app/providers/ThemeProvider.tsx` | REFACTOR (extract provider) |
| **QUERY HOOKS** | | |
| `src/hooks/queries/useWorkspaceQueries.ts` | `src/shared/api/queries/useWorkspaceQueries.ts` | MOVE (shared) |
| `src/hooks/queries/useRepoQueries.ts` | `src/shared/api/queries/useRepoQueries.ts` | MOVE (shared) |
| `src/hooks/queries/useSessionQueries.ts` | `src/features/chat/api/useSessionQueries.ts` | MOVE (chat-specific) |
| `src/hooks/queries/useSettingsQueries.ts` | `src/features/settings/api/useSettingsQueries.ts` | MOVE (settings-specific) |
| `src/hooks/queries/index.ts` | `src/shared/api/queries/index.ts` | MOVE + UPDATE |
| `src/hooks/index.ts` | `src/shared/hooks/index.ts` | MOVE + UPDATE |

### **I. LIB** (3 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/lib/queryClient.ts` | `src/shared/lib/queryClient.ts` | MOVE |
| `src/lib/queryKeys.ts` | `src/shared/lib/queryKeys.ts` | MOVE |
| `src/lib/utils.ts` | `src/shared/lib/utils.ts` | MOVE |

### **J. SERVICES** (7 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/services/api.ts` | `src/shared/api/client.ts` | MOVE + RENAME |
| `src/services/socket.ts` | `src/shared/api/socket.ts` | MOVE |
| `src/services/workspace.service.ts` | `src/shared/api/services/workspace.service.ts` | MOVE |
| `src/services/repo.service.ts` | `src/shared/api/services/repo.service.ts` | MOVE |
| `src/services/session.service.ts` | `src/shared/api/services/session.service.ts` | MOVE |
| `src/services/settings.service.ts` | `src/shared/api/services/settings.service.ts` | MOVE |
| `src/services/memory.service.ts` | `src/shared/api/services/memory.service.ts` | MOVE |
| `src/services/index.ts` | `src/shared/api/services/index.ts` | MOVE |

### **K. STORES** (3 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/stores/workspaceStore.ts` | `src/shared/stores/workspaceStore.ts` | MOVE |
| `src/stores/uiStore.ts` | `src/shared/stores/uiStore.ts` | MOVE |
| `src/stores/index.ts` | `src/shared/stores/index.ts` | MOVE |

### **L. TYPES** (7 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/types/api.types.ts` | `src/shared/types/api.types.ts` | MOVE |
| `src/types/github.types.ts` | `src/shared/types/github.types.ts` | MOVE |
| `src/types/repo.types.ts` | `src/shared/types/repo.types.ts` | MOVE |
| `src/types/session.types.ts` | `src/shared/types/session.types.ts` | MOVE |
| `src/types/settings.types.ts` | `src/shared/types/settings.types.ts` | MOVE |
| `src/types/workspace.types.ts` | `src/shared/types/workspace.types.ts` | MOVE |
| `src/types/index.ts` | `src/shared/types/index.ts` | MOVE |

### **M. UTILS** (2 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/utils/formatters.ts` | `src/shared/lib/formatters.ts` | MOVE |
| `src/utils/index.ts` | MERGE INTO | `src/shared/lib/index.ts` |

### **N. STYLES** (3 files)

| Current Path | New Path | Action |
|--------------|----------|--------|
| `src/styles.css` | `src/styles/styles.css` | MOVE |
| `src/fonts.css` | `src/styles/fonts.css` | MOVE |
| `src/vite-env.d.ts` | `src/vite-env.d.ts` | KEEP |

---

## 📝 PART 3: IMPORT UPDATE PATTERNS

### **Pattern 1: Service Imports**

```typescript
// OLD
import { apiClient } from '@/services/api';
import { WorkspaceService } from '@/services/workspace.service';

// NEW
import { apiClient } from '@/shared/api/client';
import { WorkspaceService } from '@/shared/api/services/workspace.service';
```

### **Pattern 2: Query Hooks**

```typescript
// OLD
import { useWorkspaceQueries } from '@/hooks/queries';
import { useSessionWithMessages } from '@/hooks/queries';

// NEW
import { useWorkspacesByRepo } from '@/shared/api/queries';
import { useSessionWithMessages } from '@/features/chat/api';
```

### **Pattern 3: Stores**

```typescript
// OLD
import { useWorkspaceStore } from '@/stores';
import { useUIStore } from '@/stores';

// NEW
import { useWorkspaceStore } from '@/shared/stores';
import { useUIStore } from '@/shared/stores';
```

### **Pattern 4: Types**

```typescript
// OLD
import type { Workspace, DiffStats } from '@/types';

// NEW
import type { Workspace, DiffStats } from '@/shared/types';
```

### **Pattern 5: Shared Hooks**

```typescript
// OLD
import { useSocket, useKeyboardShortcuts } from '@/hooks';

// NEW
import { useSocket, useKeyboardShortcuts } from '@/shared/hooks';
```

### **Pattern 6: Theme**

```typescript
// OLD
import { useTheme } from '@/hooks/useTheme';

// NEW
import { useTheme } from '@/app/providers/ThemeProvider';
```

### **Pattern 7: Config**

```typescript
// OLD
import { API_CONFIG } from '@/config/api.config';

// NEW
import { API_CONFIG } from '@/app/config/api.config';
```

### **Pattern 8: Lib/Utils**

```typescript
// OLD
import { queryClient } from '@/lib/queryClient';
import { formatTokenCount } from '@/utils';
import { cn } from '@/lib/utils';

// NEW
import { queryClient } from '@/shared/lib/queryClient';
import { formatTokenCount } from '@/shared/lib/formatters';
import { cn } from '@/shared/lib/utils';
```

---

## 🚀 PART 4: STEP-BY-STEP EXECUTION ORDER

### **PHASE 1: Preparation (Non-Breaking)**

**Goal:** Create new structure without breaking existing code

```bash
# Step 1.1: Create all new directories
mkdir -p src/app/{layouts/components,providers,config}
mkdir -p src/features/{workspace-sidebar/ui,welcome/ui,chat/{ui/chat,api,hooks},file-changes/ui,browser/{ui,api},terminal/ui,settings/{ui,api}}
mkdir -p src/shared/{api/{queries,services},components/{content,error-fallbacks},hooks,stores,types,lib}
mkdir -p src/styles

# Step 1.2: Verify directory structure
tree -L 4 src/
```

### **PHASE 2: Create New Files**

Create QueryProvider, ThemeProvider, WorkspaceHeader, FileChangesPanel (see detailed code in full plan)

### **PHASE 3: Move Shared Resources**

```bash
# Move types, lib, utils, config, services, stores
mv src/types/*.ts src/shared/types/
mv src/lib/*.ts src/shared/lib/
mv src/utils/formatters.ts src/shared/lib/
mv src/config/api.config.ts src/app/config/
mv src/services/api.ts src/shared/api/client.ts
mv src/services/*.ts src/shared/api/services/
mv src/stores/*.ts src/shared/stores/
```

### **PHASE 4: Move Query Hooks**

```bash
mv src/hooks/queries/useWorkspaceQueries.ts src/shared/api/queries/
mv src/hooks/queries/useRepoQueries.ts src/shared/api/queries/
mv src/hooks/queries/useSessionQueries.ts src/features/chat/api/
mv src/hooks/queries/useSettingsQueries.ts src/features/settings/api/
```

### **PHASE 5: Move Shared Components**

```bash
mv src/components/BranchName.tsx src/shared/components/
mv src/components/OpenInDropdown.tsx src/shared/components/
mv src/components/ErrorBoundary.tsx src/shared/components/
mv src/components/content/ src/shared/components/
mv src/components/error-fallbacks/ src/shared/components/
```

### **PHASE 6: Move Shared Hooks**

```bash
mv src/hooks/useSocket.ts src/shared/hooks/
mv src/hooks/useKeyboardShortcuts.ts src/shared/hooks/
mv src/hooks/use-mobile.tsx src/shared/hooks/
mv src/hooks/useAutoScroll.ts src/features/chat/hooks/
```

### **PHASE 7-12: Move Features**

Browser → Terminal → Settings → Welcome → Chat → Workspace Sidebar

### **PHASE 13: Move App Layer**

```bash
mv src/App.tsx src/app/App.tsx
mv src/main.tsx src/app/main.tsx
```

### **PHASE 14: Refactor Dashboard**

```bash
mv src/Dashboard.tsx src/app/layouts/Dashboard.tsx
# Then major refactor with all new imports
```

### **PHASE 15: Delete Old Files**

```bash
rm src/hooks/useDashboardData.ts
rm src/hooks/useWorkspaces.ts
rm src/hooks/useDiffStats.ts
rm src/hooks/useFileChanges.ts
rm src/hooks/useMessages.ts
```

### **PHASE 16: Move Styles**

```bash
mv src/styles.css src/styles/
mv src/fonts.css src/styles/
```

### **PHASE 17: Final Validation**

```bash
npm run build
npm run dev:full
```

---

## ✅ VALIDATION CHECKLIST

### **Pre-Migration**
- [ ] Git commit all current changes
- [ ] Create backup branch: `git checkout -b backup-pre-refactor`
- [ ] Ensure tests pass: `npm test`
- [ ] Ensure build works: `npm run build`

### **During Migration**
- [ ] Phase 1-17 completed in order
- [ ] TypeScript compiles after each phase
- [ ] No broken imports

### **Post-Migration**
- [ ] All features render correctly
- [ ] No console errors
- [ ] Build succeeds
- [ ] All modals work
- [ ] WebSocket connection works

---

## 🔙 ROLLBACK PLAN

```bash
# Option 1: Revert to backup
git checkout backup-pre-refactor

# Option 2: Reset to last commit
git reset --hard HEAD
```

---

## 📊 SUMMARY STATISTICS

| Metric | Count |
|--------|-------|
| **Total files** | 141 |
| **Files to move** | ~120 |
| **Files to delete** | 9 |
| **New files to create** | ~15 |
| **Import updates needed** | ~100+ files |
| **Estimated time** | 4-6 hours |

---

## 🎯 CRITICAL SUCCESS FACTORS

1. **Follow phase order strictly** - Dependencies matter
2. **Test after each phase** - Catch issues early
3. **Update imports immediately** - Don't accumulate tech debt
4. **Validate compilation** - TypeScript will catch most issues
5. **Test in browser** - Some issues only show at runtime
6. **Keep backup** - Always have rollback option

---

**End of Refactoring Plan**


----

FYI:

Big-picture, the target structure lines up with a feature-first approach and should pay off, but several parts of the execution plan are risky or incomplete:

mv commands like mv src/services/*.ts src/shared/api/services/ (REFACTORING_PLAN.md:208) assume only flat .ts files. They’ll skip folders (e.g. components/chat) and won’t delete the old directories, so you’ll need follow-up cleanups or switch to find/git mv pairs.
Terminating src/features/workspace after moving chat-only UI (REFACTORING_PLAN.md:141) might leave non-chat workspace logic behind (e.g. future store/api code). Double-check that nothing else under workspace still matters before deleting or renaming the folder.
Moving styles.css/fonts.css into src/styles/ (REFACTORING_PLAN.md:261) requires updating every import (import './styles.css', Vite entry in main.tsx, etc.). The plan doesn’t call that out, so main/app init will break unless you update those paths immediately.
Extraction of ThemeProvider and WorkspaceHeader (REFACTORING_PLAN.md:38-54) needs concrete code guidance. Without a spec for the provider API and header props, the “major refactor” at Dashboard.tsx becomes fragile.
Import rewrites are only pattern-based (REFACTORING_PLAN.md:180-232). With 100+ files touched, expect edge cases (barrel files, relative imports, default exports) that don’t match these templates; budget time to lint/compile after each phase.
Deleting hooks (REFACTORING_PLAN.md:118-125) presumes the query migration is done. If any component still references them, TypeScript won’t catch it until you run a full compile/test—plan an earlier validation step before removals.
The plan never updates tsconfig path aliases or Vite resolve settings after moving directories. If your @ alias points to src, new imports like @/shared/... are fine, but ensure no new alias (e.g. @/app) is required.
Suggestion: pilot the migration feature-by-feature (terminal, chat, etc.), using git mv so history stays intact, run tsc --noEmit after each slice, and only then tackle the app shell/dashboard refactor.