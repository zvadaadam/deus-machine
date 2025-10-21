# 🏗️ COMPREHENSIVE REFACTORING PLAN v2.0

**Date:** 2025-10-21
**Branch:** zvadaadam/walla-walla → src-structure-refactor
**Architecture:** Domain-Driven Feature-First (FSD-Lite)
**Total Files:** 141 files
**Estimated Time:** 6-8 hours
**Migration Approach:** Phased, non-breaking, fully reversible

---

## 📖 TABLE OF CONTENTS

1. [Why We're Refactoring](#why-were-refactoring)
2. [Current Problems](#current-problems)
3. [Architectural Principles](#architectural-principles)
4. [Target Structure](#target-structure)
5. [Feature Ownership Map](#feature-ownership-map)
6. [Detailed File Migration](#detailed-file-migration)
7. [Step-by-Step Execution](#step-by-step-execution)
8. [Import Update Patterns](#import-update-patterns)
9. [Validation & Testing](#validation--testing)
10. [Rollback Plan](#rollback-plan)

---

## 🎯 WHY WE'RE REFACTORING

### **The Problem**

Our codebase has grown to 141 files but lacks clear organization:

1. **Scattered Features** - Workspace code is spread across:
   - `src/Dashboard.tsx` (workspace selection logic)
   - `src/WorkspaceChatPanel.tsx` (chat UI)
   - `src/features/workspace/` (some components)
   - `src/features/dashboard/` (confusing name - actually contains modals)
   - `src/hooks/` (workspace-related hooks)
   - `src/services/` (workspace API calls)

2. **No Clear Ownership** - When adding a feature, unclear where code goes:
   - "Should this go in `components/` or `features/`?"
   - "Is this a shared hook or feature-specific?"
   - "Where do I put Tauri commands?"

3. **Tight Coupling** - Features depend on internal details of other features:
   ```typescript
   // Bad: Reaching into another feature's internals
   import { WorkspaceCard } from '@/features/workspace/components/WorkspaceCard'
   import { useWorkspaceStore } from '@/stores/workspaceStore'
   ```

4. **Mixed Concerns** - Old data-fetching patterns mixed with new TanStack Query:
   - `useDashboardData.ts` (old pattern - 166 lines)
   - `useWorkspaceQueries.ts` (new TanStack Query)
   - Both used simultaneously → confusion

5. **Platform Code Scattered** - Tauri-specific code everywhere:
   ```typescript
   // Scattered throughout 20+ files
   import { invoke } from '@tauri-apps/api/core'
   await invoke('socket_connect', { path })
   ```

### **The Goal**

Transform to a **domain-driven, feature-first architecture** where:

1. ✅ **Clear boundaries** - Each feature is a complete vertical slice
2. ✅ **Easy to find** - All workspace code in `features/workspace/`
3. ✅ **Easy to test** - Features are isolated and mockable
4. ✅ **Easy to scale** - Adding features follows clear patterns
5. ✅ **Platform abstracted** - Tauri code centralized and testable

---

## 🚨 CURRENT PROBLEMS

### **Problem 1: Feature Fragmentation**

**Example: Workspace Management**

Currently spread across 7 locations:
```
src/Dashboard.tsx                              # Workspace selection
src/WorkspaceChatPanel.tsx                     # Chat UI
src/features/workspace/components/             # Some UI
src/features/dashboard/components/             # Modals (confusing!)
src/hooks/useDashboardData.ts                  # Data fetching (old)
src/hooks/queries/useWorkspaceQueries.ts       # Data fetching (new)
src/services/workspace.service.ts              # API calls
```

**Impact:**
- 🔴 Hard to find all workspace-related code
- 🔴 Changes require touching multiple folders
- 🔴 New developers confused about structure

### **Problem 2: Naming Confusion**

```
src/features/dashboard/     # What is this? Dashboard is the layout!
├── WelcomeView.tsx         # Actually part of repository management
├── SettingsModal.tsx       # Actually application settings
├── DiffModal.tsx           # Actually part of workspace
├── SystemPromptModal.tsx   # Actually part of session (chat)
```

**Reality:**
- "Dashboard" isn't a feature - it's a layout
- Features are: **repository**, **workspace**, **session**, **settings**

### **Problem 3: No Platform Abstraction**

Tauri invoke calls scattered across codebase:

```typescript
// In 20+ different files:
import { invoke } from '@tauri-apps/api/core'

// Terminal.tsx
await invoke('pty_write', { id, data })

// BrowserPanel.tsx
await invoke('open_browser', { url })

// Dashboard.tsx
await invoke('get_backend_port')
```

**Impact:**
- 🔴 Can't test without Tauri runtime
- 🔴 Hard to swap platforms (e.g., Electron)
- 🔴 No centralized error handling

### **Problem 4: Mixed Data Patterns**

Old hooks (pre-TanStack Query) still exist:

```typescript
// OLD (should delete)
src/hooks/useDashboardData.ts    (166 lines)
src/hooks/useWorkspaces.ts       (77 lines)
src/hooks/useDiffStats.ts
src/hooks/useFileChanges.ts
src/hooks/useMessages.ts

// NEW (TanStack Query)
src/hooks/queries/useWorkspaceQueries.ts
src/hooks/queries/useSessionQueries.ts
```

Dashboard.tsx uses BOTH patterns simultaneously:
```typescript
// Line 78: Old pattern
const { repoGroups, stats, loading } = useDashboardData();

// Line 85: New pattern
const workspacesQuery = useWorkspacesByRepo('ready');
```

**Impact:**
- 🔴 Confusion about which pattern to use
- 🔴 Duplicate logic
- 🔴 Inconsistent caching behavior

### **Problem 5: Global State Soup**

```typescript
src/stores/workspaceStore.ts    # Global workspace state
src/stores/uiStore.ts           # Global UI state (modals, collapsed repos)
```

**Issues:**
- Workspace state is global, but should be feature-scoped
- UI state mixes concerns (workspace sidebar collapsed + settings modal open)
- Hard to understand what state belongs where

---

## 🎯 ARCHITECTURAL PRINCIPLES

Our new structure follows these principles:

### **1. Domain-Driven Features**

Features represent **business domains**, not UI locations:

✅ **Good Feature Names:**
- `features/repository/` - Git repository management
- `features/workspace/` - Git worktrees + file changes
- `features/session/` - AI chat sessions
- `features/terminal/` - PTY terminal sessions

❌ **Bad Feature Names:**
- `features/workspace-sidebar/` - This is navigation, not a domain
- `features/chat/` - Too vague, sessions are the domain
- `features/file-changes/` - File changes ARE a workspace concern

### **2. Vertical Slice Architecture**

Each feature owns **everything** for its domain:

```
features/workspace/
├── ui/              # ALL workspace UI components
├── api/             # ALL workspace data fetching
├── store/           # Workspace-specific state
├── hooks/           # Workspace-specific hooks
├── types.ts         # Workspace types
└── index.ts         # Public API exports
```

**Benefits:**
- ✅ Everything related in one place
- ✅ Easy to understand dependencies
- ✅ Easy to test in isolation
- ✅ Easy to delete/refactor

### **3. Platform Abstraction**

Separate platform-specific code:

```
platform/tauri/
├── commands/        # Wrappers for invoke()
├── events/          # Event listeners
└── socket/          # Unix socket client
```

**Before:**
```typescript
// Scattered everywhere
import { invoke } from '@tauri-apps/api/core'
await invoke('socket_connect', { path })
```

**After:**
```typescript
// Centralized
import { socketCommands } from '@/platform/tauri'
await socketCommands.connect(path)
```

**Benefits:**
- ✅ Easy to mock for testing
- ✅ Could swap Tauri for Electron
- ✅ Centralized error handling
- ✅ Type-safe platform APIs

### **4. Public API Exports**

Features export **only** their public API:

```typescript
// features/workspace/index.ts

// ✅ Exported (public API)
export { WorkspaceCard } from './ui/WorkspaceCard'
export { useWorkspaces, useCreateWorkspace } from './api/workspace.queries'
export type { Workspace } from './types'

// ❌ Not exported (private implementation)
// - store/workspaceStore.ts (internal state)
// - api/workspace.service.ts (internal HTTP)
// - ui/WorkspaceActions.tsx (internal component)
```

**Benefits:**
- ✅ Can't accidentally couple features
- ✅ Clear API boundaries
- ✅ Easy to refactor internals

### **5. Minimal Shared**

Only **truly cross-cutting** code goes in `shared/`:

✅ **Belongs in shared/:**
- `shared/api/client.ts` - Used by ALL features
- `shared/components/BranchName.tsx` - Used by 3+ features
- `shared/hooks/useKeyboardShortcuts.ts` - Global shortcuts

❌ **Doesn't belong in shared/:**
- `useAutoScroll` - Only used in session → `features/session/hooks/`
- `useDevBrowser` - Only used in browser → `features/browser/hooks/`
- `DiffModal` - Only used in workspace → `features/workspace/ui/`

---

## 🏗️ TARGET STRUCTURE

```
src/
├── app/                                    # 🎯 Application Shell
│   ├── providers/
│   │   ├── QueryClientProvider.tsx        # TanStack Query setup
│   │   ├── ThemeProvider.tsx              # Theme context + hook
│   │   └── index.ts                       # Compose all providers
│   ├── layouts/
│   │   ├── MainLayout.tsx                 # Main app layout (rename from Dashboard)
│   │   └── components/
│   │       └── WorkspaceHeader.tsx        # Extract from Dashboard (Branch + OpenIn)
│   ├── config/
│   │   ├── api.config.ts                  # API endpoints + config
│   │   └── constants.ts                   # Global constants
│   ├── App.tsx                            # Root component
│   └── main.tsx                           # Entry point
│
├── features/                               # 🎯 Domain Features
│   │
│   ├── repository/                         # Git repositories management
│   │   ├── ui/
│   │   │   ├── WelcomeView.tsx            # Landing page with repo actions
│   │   │   ├── RepoGroup.tsx              # Repository grouping component
│   │   │   ├── NewWorkspaceModal.tsx      # Create workspace modal
│   │   │   ├── CloneRepositoryModal.tsx   # Clone from GitHub modal
│   │   │   └── index.ts
│   │   ├── api/
│   │   │   ├── repository.service.ts      # HTTP: addRepo, removeRepo, clone
│   │   │   ├── repository.queries.ts      # useRepositories, useAddRepository, useCloneRepository
│   │   │   └── index.ts
│   │   ├── types.ts                       # Repo, RepoGroup types
│   │   └── index.ts                       # Public API
│   │
│   ├── workspace/                          # Git worktrees + file changes
│   │   ├── ui/
│   │   │   ├── WorkspaceList.tsx          # List of workspaces
│   │   │   ├── WorkspaceCard.tsx          # Workspace card for sidebar
│   │   │   ├── WorkspaceItem.tsx          # Workspace list item
│   │   │   ├── FileChangesPanel.tsx       # File changes viewer (right panel)
│   │   │   ├── DiffModal.tsx              # Full diff viewer modal
│   │   │   ├── DiffStats.tsx              # +/- statistics display
│   │   │   └── index.ts
│   │   ├── api/
│   │   │   ├── workspace.service.ts       # HTTP: create, archive, getDiff, getFileChanges
│   │   │   ├── workspace.queries.ts       # useWorkspaces, useCreateWorkspace, useDiffStats, useFileChanges
│   │   │   └── index.ts
│   │   ├── store/
│   │   │   └── workspaceStore.ts          # Active workspace, UI state
│   │   ├── types.ts                       # Workspace, DiffStats, FileChange types
│   │   └── index.ts                       # Public API
│   │
│   ├── session/                            # AI chat sessions
│   │   ├── ui/
│   │   │   ├── SessionPanel.tsx           # Main chat panel (rename from WorkspaceChatPanel)
│   │   │   ├── Chat.tsx                   # Chat messages container
│   │   │   ├── MessageInput.tsx           # Message input box
│   │   │   ├── MessageItem.tsx            # Individual message
│   │   │   ├── SystemPromptModal.tsx      # Edit CLAUDE.md
│   │   │   ├── FileChangesPanel.tsx       # File changes in modal view
│   │   │   ├── message/
│   │   │   │   ├── MessageItem.tsx
│   │   │   │   └── index.ts
│   │   │   ├── blocks/                    # Content blocks
│   │   │   │   ├── BlockRenderer.tsx
│   │   │   │   ├── TextBlock.tsx
│   │   │   │   ├── ThinkingBlock.tsx
│   │   │   │   ├── ToolUseBlock.tsx
│   │   │   │   ├── ToolResultBlock.tsx
│   │   │   │   └── index.ts
│   │   │   ├── tools/                     # Tool renderers
│   │   │   │   ├── ToolRegistry.tsx
│   │   │   │   ├── registerTools.ts
│   │   │   │   ├── components/
│   │   │   │   │   ├── CodeBlock.tsx
│   │   │   │   │   ├── SyntaxHighlighter.tsx
│   │   │   │   │   ├── CopyButton.tsx
│   │   │   │   │   ├── FilePathDisplay.tsx
│   │   │   │   │   └── index.ts
│   │   │   │   ├── renderers/
│   │   │   │   │   ├── BashToolRenderer.tsx
│   │   │   │   │   ├── ReadToolRenderer.tsx
│   │   │   │   │   ├── WriteToolRenderer.tsx
│   │   │   │   │   ├── EditToolRenderer.tsx
│   │   │   │   │   ├── GrepToolRenderer.tsx
│   │   │   │   │   ├── GlobToolRenderer.tsx
│   │   │   │   │   ├── TaskToolRenderer.tsx
│   │   │   │   │   ├── TodoWriteToolRenderer.tsx
│   │   │   │   │   ├── WebSearchToolRenderer.tsx
│   │   │   │   │   ├── BashOutputToolRenderer.tsx
│   │   │   │   │   ├── KillShellToolRenderer.tsx
│   │   │   │   │   ├── LSToolRenderer.tsx
│   │   │   │   │   ├── MultiEditToolRenderer.tsx
│   │   │   │   │   ├── WebFetchToolRenderer.tsx
│   │   │   │   │   ├── DefaultToolRenderer.tsx
│   │   │   │   │   └── index.ts
│   │   │   │   ├── utils/
│   │   │   │   │   └── detectLanguage.ts
│   │   │   │   ├── types.ts
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── api/
│   │   │   ├── session.service.ts         # HTTP: getMessages, sendMessage, stopSession
│   │   │   ├── session.queries.ts         # useSessionMessages, useSendMessage, useStopSession
│   │   │   └── index.ts
│   │   ├── hooks/
│   │   │   └── useAutoScroll.ts           # Session-specific auto-scroll
│   │   ├── types.ts                       # Message, Session, ToolUse types
│   │   └── index.ts                       # Public API
│   │
│   ├── terminal/                           # PTY terminal sessions
│   │   ├── ui/
│   │   │   ├── TerminalPanel.tsx          # Terminal panel wrapper
│   │   │   ├── Terminal.tsx               # XTerm component
│   │   │   └── Terminal.css               # Terminal styles
│   │   ├── api/
│   │   │   └── terminal.commands.ts       # Tauri PTY commands wrapper
│   │   ├── hooks/
│   │   │   └── useTerminal.ts             # Terminal session management
│   │   ├── types.ts
│   │   └── index.ts
│   │
│   ├── browser/                            # Dev server browser
│   │   ├── ui/
│   │   │   ├── BrowserPanel.tsx           # Browser iframe panel
│   │   │   └── BrowserControls.tsx        # Browser controls (if needed)
│   │   ├── api/
│   │   │   └── browser.commands.ts        # Tauri browser commands wrapper
│   │   ├── hooks/
│   │   │   └── useBrowser.ts              # Browser state management (rename from useDevBrowser)
│   │   ├── types.ts
│   │   └── index.ts
│   │
│   ├── settings/                           # Application settings
│   │   ├── ui/
│   │   │   ├── SettingsModal.tsx          # Main settings modal
│   │   │   ├── sections/
│   │   │   │   ├── AccountSection.tsx     # Account settings
│   │   │   │   ├── GeneralSection.tsx     # General settings
│   │   │   │   ├── TerminalSection.tsx    # Terminal settings
│   │   │   │   ├── MemorySection.tsx      # Memory settings
│   │   │   │   ├── ProviderSection.tsx    # Provider settings
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── api/
│   │   │   ├── settings.service.ts        # HTTP: getSettings, saveSettings
│   │   │   ├── settings.queries.ts        # useSettings, useSaveSettings, useMCPServers, etc.
│   │   │   └── index.ts
│   │   ├── types.ts                       # Settings, MCPServer, Command types
│   │   └── index.ts
│   │
│   └── sidebar/                            # App navigation sidebar
│       ├── ui/
│       │   ├── AppSidebar.tsx             # Main sidebar (rename from app-sidebar)
│       │   └── index.ts
│       ├── store/
│       │   └── sidebarStore.ts            # Sidebar UI state (collapsed repos, etc.)
│       └── index.ts
│
├── platform/                               # 🎯 Platform-Specific Code
│   ├── tauri/
│   │   ├── commands/
│   │   │   ├── socket.ts                  # Unix socket commands
│   │   │   ├── pty.ts                     # PTY commands
│   │   │   ├── browser.ts                 # Browser commands
│   │   │   ├── fs.ts                      # File system commands
│   │   │   └── index.ts
│   │   ├── events/
│   │   │   ├── socketEvents.ts            # Socket event listeners
│   │   │   └── index.ts
│   │   ├── socket/
│   │   │   ├── SocketClient.ts            # Unix socket wrapper
│   │   │   └── types.ts
│   │   └── index.ts
│   │
│   └── web/                                # Web-only code (if needed)
│       └── index.ts
│
├── shared/                                 # 🎯 Truly Shared Code
│   ├── api/
│   │   ├── client.ts                      # Base HTTP client (rename from services/api.ts)
│   │   ├── socket.ts                      # WebSocket/Unix socket abstraction
│   │   ├── queryClient.ts                 # TanStack Query client config
│   │   ├── queryKeys.ts                   # Shared query key factory
│   │   └── index.ts
│   │
│   ├── components/
│   │   ├── BranchName.tsx                 # Branch badge (used in 3+ features)
│   │   ├── OpenInDropdown.tsx             # Open in IDE/Finder (used in header)
│   │   ├── ErrorBoundary.tsx              # Error boundary wrapper
│   │   ├── EmptyState.tsx                 # Generic empty state (consolidate from content/)
│   │   ├── error-fallbacks/
│   │   │   ├── DashboardError.tsx
│   │   │   └── index.ts
│   │   └── index.ts
│   │
│   ├── hooks/
│   │   ├── useKeyboardShortcuts.ts        # Global keyboard shortcuts
│   │   ├── useSocket.ts                   # WebSocket connection hook
│   │   ├── use-mobile.tsx                 # Mobile detection
│   │   └── index.ts
│   │
│   ├── lib/
│   │   ├── utils.ts                       # Generic utilities (cn, etc.)
│   │   ├── formatters.ts                  # Date, number, token formatters
│   │   └── index.ts
│   │
│   ├── types/
│   │   ├── api.types.ts                   # Shared API types (ApiError, etc.)
│   │   ├── common.types.ts                # Common domain types
│   │   └── index.ts
│   │
│   └── stores/
│       └── uiStore.ts                     # Global UI state (modals only)
│
├── components/                             # 🎯 shadcn/ui Components
│   └── ui/                                 # Generated by shadcn CLI
│       ├── button.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── ... (all 30+ shadcn components)
│       └── index.ts
│
└── styles/
    ├── styles.css                          # Tailwind entry + global styles
    └── fonts.css                           # Font faces
```

---

## 🗺️ FEATURE OWNERSHIP MAP

### **What Each Feature Owns**

| Feature | Domain | UI Components | Data | State |
|---------|--------|---------------|------|-------|
| **repository** | Git repos | WelcomeView, CloneModal, NewWorkspaceModal, RepoGroup | Repositories from DB | - |
| **workspace** | Worktrees + files | WorkspaceList, WorkspaceCard, FileChangesPanel, DiffModal, DiffStats | Workspaces, file changes, diffs | Active workspace, diff stats cache |
| **session** | AI chat | SessionPanel, Chat, MessageInput, messages, tool renderers, SystemPromptModal | Messages, session state | - |
| **terminal** | PTY sessions | TerminalPanel, Terminal | Terminal buffers | Terminal sessions |
| **browser** | Dev servers | BrowserPanel | Dev server URLs | Browser state |
| **settings** | App config | SettingsModal, all sections | Settings from DB | - |
| **sidebar** | Navigation | AppSidebar | - | Collapsed repos, sidebar state |

### **Feature Dependencies**

```
app/layouts/MainLayout
├── sidebar/           (always visible)
├── repository/        (when no workspace selected)
│   └── uses: workspace.queries (to show workspaces in WelcomeView)
├── workspace/         (when workspace selected)
│   └── uses: nothing (self-contained)
├── session/           (when workspace selected)
│   └── uses: workspace.types (SessionPanel needs workspace.active_session_id)
├── terminal/          (tab in right panel)
├── browser/           (tab in right panel)
└── settings/          (modal)
```

**Rule:** Features can only depend on other features via **public API exports** (index.ts)

---

## 📦 DETAILED FILE MIGRATION

### **A. FILES TO DELETE** (9 files)

These files are **replaced by TanStack Query**:

```bash
# Old data-fetching hooks (pre-TanStack Query)
src/hooks/useDashboardData.ts       # 166 lines - replaced by useWorkspacesByRepo + useStats
src/hooks/useWorkspaces.ts          # 77 lines - replaced by useWorkspacesByRepo
src/hooks/useDiffStats.ts           # replaced by useDiffStats in workspace.queries
src/hooks/useFileChanges.ts         # replaced by useFileChanges in workspace.queries
src/hooks/useMessages.ts            # replaced by useSessionQueries

# Empty directories after migration
src/config/                         # moved to app/config/
src/services/                       # moved to shared/api/ and platform/tauri/
src/stores/                         # moved to features/*/store/ and shared/stores/
src/types/                          # moved to shared/types/ and features/*/types.ts
src/utils/                          # moved to shared/lib/
src/lib/                            # moved to shared/lib/
src/hooks/                          # moved to shared/hooks/ and features/*/hooks/
```

### **B. APP LAYER** (7 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/App.tsx` | `src/app/App.tsx` | MOVE + REFACTOR<br>• Extract providers to app/providers/<br>• Simplify to just provider composition |
| `src/main.tsx` | `src/app/main.tsx` | MOVE + UPDATE<br>• Update import: `./App` (no change needed) |
| `src/Dashboard.tsx` | `src/app/layouts/MainLayout.tsx` | MOVE + RENAME + MAJOR REFACTOR<br>• Extract WorkspaceHeader (lines 499-513)<br>• Update all feature imports to new paths<br>• Simplify to pure composition (~300 lines target) |
| `src/config/api.config.ts` | `src/app/config/api.config.ts` | MOVE |
| - | `src/app/config/constants.ts` | CREATE NEW<br>• Extract constants from various files |
| `src/hooks/useTheme.tsx` | `src/app/providers/ThemeProvider.tsx` | MOVE + REFACTOR<br>• Keep ThemeProvider component<br>• Keep useTheme hook<br>• Export both |
| - | `src/app/providers/QueryClientProvider.tsx` | CREATE NEW<br>• Extract from App.tsx<br>• Wrap QueryClientProvider + DevTools |
| - | `src/app/providers/index.ts` | CREATE NEW<br>• Export all providers |
| - | `src/app/layouts/components/WorkspaceHeader.tsx` | CREATE NEW<br>• Extract from Dashboard lines 499-513<br>• Branch name + OpenIn dropdown |

### **C. FEATURES - REPOSITORY** (5 files)

All from `src/features/dashboard/components/`:

| Current Path | New Path | Reason |
|--------------|----------|--------|
| `WelcomeView.tsx` | `features/repository/ui/WelcomeView.tsx` | Welcome is about adding repositories |
| `NewWorkspaceModal.tsx` | `features/repository/ui/NewWorkspaceModal.tsx` | Creates workspace for a repository |
| `CloneRepositoryModal.tsx` | `features/repository/ui/CloneRepositoryModal.tsx` | Clones a new repository |
| `RepoGroup.tsx` | `features/repository/ui/RepoGroup.tsx` | Displays repository groups |
| `WorkspaceItem.tsx` | `features/repository/ui/WorkspaceItem.tsx` | Shows workspace in WelcomeView |
| - | `features/repository/ui/index.ts` | CREATE NEW - exports |
| `src/services/repo.service.ts` | `features/repository/api/repository.service.ts` | MOVE + UPDATE imports |
| `src/hooks/queries/useRepoQueries.ts` | `features/repository/api/repository.queries.ts` | MOVE + RENAME + UPDATE imports |
| - | `features/repository/api/index.ts` | CREATE NEW - exports |
| `src/types/repo.types.ts` | `features/repository/types.ts` | MOVE |
| - | `features/repository/index.ts` | CREATE NEW - public API |

**Update imports:**
```typescript
// In WelcomeView.tsx
- import { useRepos } from '@/hooks/queries'
+ import { useRepositories } from '../api/repository.queries'
```

### **D. FEATURES - WORKSPACE** (20+ files)

| Current Path | New Path | Reason |
|--------------|----------|--------|
| `src/features/dashboard/components/DiffModal.tsx` | `features/workspace/ui/DiffModal.tsx` | Diff viewing is workspace concern |
| - | `features/workspace/ui/FileChangesPanel.tsx` | CREATE NEW<br>• Extract from Dashboard lines 600-678<br>• Dev servers + file changes |
| - | `features/workspace/ui/WorkspaceList.tsx` | CREATE NEW (optional)<br>• Extract workspace list logic if needed |
| - | `features/workspace/ui/WorkspaceCard.tsx` | CREATE NEW (optional)<br>• Extract workspace card if needed |
| - | `features/workspace/ui/DiffStats.tsx` | CREATE NEW (optional)<br>• Extract diff stats display |
| - | `features/workspace/ui/index.ts` | CREATE NEW - exports |
| `src/services/workspace.service.ts` | `features/workspace/api/workspace.service.ts` | MOVE |
| `src/hooks/queries/useWorkspaceQueries.ts` | `features/workspace/api/workspace.queries.ts` | MOVE + RENAME |
| - | `features/workspace/api/index.ts` | CREATE NEW - exports |
| `src/stores/workspaceStore.ts` | `features/workspace/store/workspaceStore.ts` | MOVE |
| `src/types/workspace.types.ts` | `features/workspace/types.ts` | MOVE |
| - | `features/workspace/index.ts` | CREATE NEW - public API |

**Update imports:**
```typescript
// In FileChangesPanel.tsx
- import { useFileChanges } from '@/hooks/queries'
+ import { useFileChanges } from '../api/workspace.queries'

- import { useWorkspaceStore } from '@/stores'
+ import { useWorkspaceStore } from '../store/workspaceStore'
```

### **E. FEATURES - SESSION** (45+ files)

This is the **largest migration** (chat → session):

| Current Path | New Path | Reason |
|--------------|----------|--------|
| `src/WorkspaceChatPanel.tsx` | `features/session/ui/SessionPanel.tsx` | RENAME: sessions are the domain |
| `src/features/workspace/components/Chat.tsx` | `features/session/ui/Chat.tsx` | MOVE |
| `src/features/workspace/components/MessageInput.tsx` | `features/session/ui/MessageInput.tsx` | MOVE |
| `src/features/workspace/components/MessageItem.tsx` | `features/session/ui/MessageItem.tsx` | MOVE |
| `src/features/dashboard/components/SystemPromptModal.tsx` | `features/session/ui/SystemPromptModal.tsx` | System prompt is session config |
| `src/features/workspace/components/FileChangesPanel.tsx` | `features/session/ui/FileChangesPanel.tsx` | Used in modal view |
| `src/features/workspace/components/chat/` | `features/session/ui/` | MOVE entire nested structure |
| - | `features/session/ui/index.ts` | CREATE NEW - exports |
| `src/hooks/queries/useSessionQueries.ts` | `features/session/api/session.queries.ts` | MOVE + RENAME |
| `src/services/session.service.ts` | `features/session/api/session.service.ts` | MOVE |
| - | `features/session/api/index.ts` | CREATE NEW - exports |
| `src/hooks/useAutoScroll.ts` | `features/session/hooks/useAutoScroll.ts` | Session-specific hook |
| - | `features/session/hooks/index.ts` | CREATE NEW - exports |
| `src/types/session.types.ts` | `features/session/types.ts` | MOVE |
| - | `features/session/index.ts` | CREATE NEW - public API |

**Nested structure (40+ files):**

```
features/session/ui/
├── SessionPanel.tsx               [WorkspaceChatPanel.tsx]
├── Chat.tsx
├── MessageInput.tsx
├── MessageItem.tsx
├── SystemPromptModal.tsx
├── FileChangesPanel.tsx
├── message/
│   ├── MessageItem.tsx
│   └── index.ts
├── blocks/
│   ├── BlockRenderer.tsx
│   ├── TextBlock.tsx
│   ├── ThinkingBlock.tsx
│   ├── ToolUseBlock.tsx
│   ├── ToolResultBlock.tsx
│   └── index.ts
├── tools/
│   ├── ToolRegistry.tsx
│   ├── registerTools.ts
│   ├── types.ts
│   ├── components/
│   │   ├── CodeBlock.tsx
│   │   ├── SyntaxHighlighter.tsx
│   │   ├── CopyButton.tsx
│   │   ├── FilePathDisplay.tsx
│   │   └── index.ts
│   ├── renderers/
│   │   ├── BashToolRenderer.tsx
│   │   ├── BashOutputToolRenderer.tsx
│   │   ├── ReadToolRenderer.tsx
│   │   ├── WriteToolRenderer.tsx
│   │   ├── EditToolRenderer.tsx
│   │   ├── GrepToolRenderer.tsx
│   │   ├── GlobToolRenderer.tsx
│   │   ├── LSToolRenderer.tsx
│   │   ├── MultiEditToolRenderer.tsx
│   │   ├── TaskToolRenderer.tsx
│   │   ├── TodoWriteToolRenderer.tsx
│   │   ├── WebSearchToolRenderer.tsx
│   │   ├── WebFetchToolRenderer.tsx
│   │   ├── KillShellToolRenderer.tsx
│   │   ├── DefaultToolRenderer.tsx
│   │   └── index.ts
│   ├── utils/
│   │   └── detectLanguage.ts
│   └── index.ts
└── index.ts
```

**Update imports in all session files:**
```typescript
// In SessionPanel.tsx
- import { Chat, MessageInput } from './features/workspace/components'
+ import { Chat, MessageInput } from './ui'

- import { useSessionQueries } from '@/hooks/queries'
+ import { useSessionWithMessages } from '../api/session.queries'

- import { useAutoScroll } from '@/hooks'
+ import { useAutoScroll } from '../hooks/useAutoScroll'
```

### **F. FEATURES - TERMINAL** (3 files)

**Simplest migration** (fewest dependencies):

| Current Path | New Path |
|--------------|----------|
| `src/TerminalPanel.tsx` | `features/terminal/ui/TerminalPanel.tsx` |
| `src/Terminal.tsx` | `features/terminal/ui/Terminal.tsx` |
| `src/Terminal.css` | `features/terminal/ui/Terminal.css` |
| - | `features/terminal/ui/index.ts` (CREATE NEW) |
| - | `features/terminal/api/terminal.commands.ts` (CREATE NEW)<br>• Wrapper for Tauri PTY commands |
| - | `features/terminal/hooks/useTerminal.ts` (CREATE NEW - optional)<br>• Terminal state management |
| `src/types/...` | `features/terminal/types.ts` (if needed) |
| - | `features/terminal/index.ts` (CREATE NEW) |

**Update imports:**
```typescript
// In TerminalPanel.tsx
- import { Terminal } from './Terminal'
+ import { Terminal } from './Terminal'  // No change (relative)

// Add Tauri wrapper
- import { invoke } from '@tauri-apps/api/core'
+ import { terminalCommands } from '../api/terminal.commands'
```

### **G. FEATURES - BROWSER** (3 files)

| Current Path | New Path |
|--------------|----------|
| `src/features/browser/components/BrowserPanel.tsx` | `features/browser/ui/BrowserPanel.tsx` |
| `src/features/browser/components/index.ts` | `features/browser/ui/index.ts` (UPDATE) |
| `src/features/browser/hooks/useDevBrowser.ts` | `features/browser/hooks/useBrowser.ts` (RENAME) |
| - | `features/browser/hooks/index.ts` (CREATE NEW) |
| - | `features/browser/api/browser.commands.ts` (CREATE NEW)<br>• Wrapper for Tauri browser commands |
| - | `features/browser/types.ts` (CREATE NEW if needed) |
| - | `features/browser/index.ts` (CREATE NEW) |

**Update imports:**
```typescript
// In BrowserPanel.tsx
- import { useDevBrowser } from '../hooks/useDevBrowser'
+ import { useBrowser } from '../hooks/useBrowser'
```

### **H. FEATURES - SETTINGS** (14 files)

| Current Path | New Path |
|--------------|----------|
| `src/features/dashboard/components/SettingsModal.tsx` | `features/settings/ui/SettingsModal.tsx` |
| `src/features/dashboard/components/settings-sections/` | `features/settings/ui/sections/` (MOVE folder) |
| - | `features/settings/ui/index.ts` (CREATE NEW) |
| `src/hooks/queries/useSettingsQueries.ts` | `features/settings/api/settings.queries.ts` (MOVE + RENAME) |
| `src/services/settings.service.ts` | `features/settings/api/settings.service.ts` (MOVE) |
| `src/services/memory.service.ts` | `features/settings/api/memory.service.ts` (MOVE - memory is part of settings) |
| - | `features/settings/api/index.ts` (CREATE NEW) |
| `src/types/settings.types.ts` | `features/settings/types.ts` (MOVE) |
| - | `features/settings/index.ts` (CREATE NEW) |

**Settings sections (7 files):**
```
features/settings/ui/sections/
├── AccountSection.tsx
├── GeneralSection.tsx
├── TerminalSection.tsx
├── MemorySection.tsx
├── ProviderSection.tsx
├── types.ts
└── index.ts
```

**Update imports:**
```typescript
// In SettingsModal.tsx
- import { useSettings, useUpdateSettings } from '@/hooks/queries'
+ import { useSettings, useUpdateSettings } from '../api/settings.queries'

- import { AccountSection } from './settings-sections'
+ import { AccountSection } from './sections'
```

### **I. FEATURES - SIDEBAR** (2 files)

| Current Path | New Path | Reason |
|--------------|----------|--------|
| `src/components/app-sidebar.tsx` | `features/sidebar/ui/AppSidebar.tsx` | Sidebar is navigation feature |
| - | `features/sidebar/ui/index.ts` | CREATE NEW - exports |
| `src/stores/uiStore.ts` | `features/sidebar/store/sidebarStore.ts` | MOVE + REFACTOR<br>• Extract only sidebar state (collapsed repos)<br>• Modal state moves to shared/stores/uiStore.ts |
| - | `features/sidebar/index.ts` | CREATE NEW - public API |

**Update imports:**
```typescript
// In AppSidebar.tsx
- import { useUIStore } from '@/stores'
+ import { useSidebarStore } from '../store/sidebarStore'

- import type { Workspace } from '@/types'
+ import type { Workspace } from '@/features/workspace'
```

### **J. PLATFORM LAYER** (NEW - 10+ files)

**Create new platform abstraction:**

```
platform/tauri/
├── commands/
│   ├── socket.ts              [CREATE NEW - wrap socket invoke calls]
│   ├── pty.ts                 [CREATE NEW - wrap PTY invoke calls]
│   ├── browser.ts             [CREATE NEW - wrap browser invoke calls]
│   ├── fs.ts                  [CREATE NEW - wrap FS invoke calls]
│   └── index.ts               [CREATE NEW - export all]
│
├── events/
│   ├── socketEvents.ts        [CREATE NEW - socket event listeners]
│   └── index.ts               [CREATE NEW - exports]
│
├── socket/
│   ├── SocketClient.ts        [EXTRACT from services/socket.ts]
│   ├── types.ts               [CREATE NEW]
│   └── index.ts               [CREATE NEW]
│
└── index.ts                   [CREATE NEW - public API]
```

**Example command wrapper:**

```typescript
// platform/tauri/commands/pty.ts
import { invoke } from '@tauri-apps/api/core'

export const ptyCommands = {
  create: (workspacePath: string) =>
    invoke<string>('pty_create', { workspacePath }),

  write: (id: string, data: string) =>
    invoke('pty_write', { id, data }),

  resize: (id: string, cols: number, rows: number) =>
    invoke('pty_resize', { id, cols, rows }),

  close: (id: string) =>
    invoke('pty_close', { id }),
}
```

**Usage:**
```typescript
// Before
import { invoke } from '@tauri-apps/api/core'
await invoke('pty_write', { id, data })

// After
import { ptyCommands } from '@/platform/tauri'
await ptyCommands.write(id, data)
```

### **K. SHARED** (25+ files)

#### **shared/api/** (8 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/services/api.ts` | `shared/api/client.ts` | MOVE + RENAME<br>• Base HTTP client |
| `src/services/socket.ts` | `platform/tauri/socket/SocketClient.ts` | MOVE (to platform, not shared) |
| `src/lib/queryClient.ts` | `shared/api/queryClient.ts` | MOVE |
| `src/lib/queryKeys.ts` | `shared/api/queryKeys.ts` | MOVE |
| - | `shared/api/index.ts` | CREATE NEW - exports |

#### **shared/components/** (6 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/components/BranchName.tsx` | `shared/components/BranchName.tsx` | MOVE (used in 3+ places) |
| `src/components/OpenInDropdown.tsx` | `shared/components/OpenInDropdown.tsx` | MOVE (used in header) |
| `src/components/ErrorBoundary.tsx` | `shared/components/ErrorBoundary.tsx` | MOVE |
| `src/components/content/empty-state.tsx` | `shared/components/EmptyState.tsx` | MOVE + RENAME |
| `src/components/ui/EmptyState.tsx` | DELETE (duplicate) | Use shared/components/EmptyState.tsx |
| `src/components/error-fallbacks/` | `shared/components/error-fallbacks/` | MOVE (entire folder) |
| - | `shared/components/index.ts` | CREATE NEW - exports |

#### **shared/hooks/** (4 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/hooks/useSocket.ts` | `shared/hooks/useSocket.ts` | MOVE (used by session) |
| `src/hooks/useKeyboardShortcuts.ts` | `shared/hooks/useKeyboardShortcuts.ts` | MOVE (global shortcuts) |
| `src/hooks/use-mobile.tsx` | `shared/hooks/use-mobile.tsx` | MOVE |
| `src/hooks/index.ts` | `shared/hooks/index.ts` | MOVE + UPDATE |

#### **shared/lib/** (4 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/lib/utils.ts` | `shared/lib/utils.ts` | MOVE |
| `src/utils/formatters.ts` | `shared/lib/formatters.ts` | MOVE |
| `src/utils/index.ts` | DELETE | Merge into shared/lib/index.ts |
| - | `shared/lib/index.ts` | CREATE NEW - exports |

#### **shared/types/** (4 files)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/types/api.types.ts` | `shared/types/api.types.ts` | MOVE |
| `src/types/github.types.ts` | `shared/types/github.types.ts` | MOVE (if truly shared) |
| `src/types/index.ts` | `shared/types/index.ts` | MOVE + UPDATE |
| - | `shared/types/common.types.ts` | CREATE NEW (optional) |

#### **shared/stores/** (1 file)

| Current Path | New Path | Changes |
|--------------|----------|---------|
| `src/stores/uiStore.ts` | `shared/stores/uiStore.ts` | MOVE + REFACTOR<br>• Keep only modal state<br>• Move sidebar state to features/sidebar/store/ |

### **L. STYLES** (2 files)

| Current Path | New Path |
|--------------|----------|
| `src/styles.css` | `src/styles/styles.css` |
| `src/fonts.css` | `src/styles/fonts.css` |

### **M. KEEP AS-IS** (30+ files)

```
src/components/ui/              # shadcn components - NO CHANGES
src/vite-env.d.ts               # Vite types - NO CHANGES
```

---

## 🚀 STEP-BY-STEP EXECUTION

### **PHASE 0: Preparation** (5 minutes)

```bash
# 0.1: Commit current state
git add .
git commit -m "checkpoint: before refactoring"

# 0.2: Create backup branch
git branch backup-pre-refactor

# 0.3: Verify build works
npm run build

# 0.4: Verify dev server works
npm run dev:full
# Test: Open app, select workspace, send message
```

### **PHASE 1: Create Directory Structure** (10 minutes)

```bash
# 1.1: Create app/ structure
mkdir -p src/app/{layouts/components,providers,config}

# 1.2: Create features/ structure
mkdir -p src/features/{repository,workspace,session,terminal,browser,settings,sidebar}/{ui,api,store,hooks}

# Special nested structures
mkdir -p src/features/session/ui/{message,blocks,tools/{components,renderers,utils}}
mkdir -p src/features/settings/ui/sections

# 1.3: Create platform/ structure
mkdir -p src/platform/tauri/{commands,events,socket}
mkdir -p src/platform/web

# 1.4: Create shared/ structure
mkdir -p src/shared/{api,components/error-fallbacks,hooks,lib,types,stores}

# 1.5: Create styles/
mkdir -p src/styles

# 1.6: Verify structure
tree -L 4 src/ | head -100
```

**Expected output:**
```
src/
├── app/
│   ├── config/
│   ├── layouts/
│   │   └── components/
│   └── providers/
├── features/
│   ├── browser/
│   │   ├── api/
│   │   ├── hooks/
│   │   └── ui/
│   ├── repository/
│   │   ├── api/
│   │   ├── types.ts (will create)
│   │   └── ui/
│   ├── session/
│   │   ├── api/
│   │   ├── hooks/
│   │   ├── types.ts (will create)
│   │   └── ui/
│   │       ├── blocks/
│   │       ├── message/
│   │       └── tools/
│   ├── settings/
│   │   ├── api/
│   │   ├── types.ts (will create)
│   │   └── ui/
│   │       └── sections/
│   ├── sidebar/
│   │   ├── store/
│   │   └── ui/
│   ├── terminal/
│   │   ├── api/
│   │   ├── hooks/
│   │   └── ui/
│   └── workspace/
│       ├── api/
│       ├── store/
│       ├── types.ts (will create)
│       └── ui/
├── platform/
│   ├── tauri/
│   │   ├── commands/
│   │   ├── events/
│   │   └── socket/
│   └── web/
├── shared/
│   ├── api/
│   ├── components/
│   │   └── error-fallbacks/
│   ├── hooks/
│   ├── lib/
│   ├── stores/
│   └── types/
└── styles/
```

### **PHASE 2: Move Shared Resources** (30 minutes)

**Goal:** Move least-dependent files first (no feature dependencies)

```bash
# 2.1: Move types (NO dependencies)
mv src/types/api.types.ts src/shared/types/
mv src/types/github.types.ts src/shared/types/
mv src/types/index.ts src/shared/types/

# 2.2: Move lib files
mv src/lib/queryClient.ts src/shared/api/
mv src/lib/queryKeys.ts src/shared/api/
mv src/lib/utils.ts src/shared/lib/

# 2.3: Move utils
mv src/utils/formatters.ts src/shared/lib/

# 2.4: Move config
mv src/config/api.config.ts src/app/config/

# 2.5: Move base API client
mv src/services/api.ts src/shared/api/client.ts

# 2.6: Update imports in moved files
# In shared/api/client.ts:
# - import { API_CONFIG } from '../config/api.config'
# + import { API_CONFIG } from '@/app/config/api.config'
```

**Test after Phase 2:**
```bash
npm run build
# Should compile (no runtime test yet)
```

### **PHASE 3: Move Shared Components & Hooks** (20 minutes)

```bash
# 3.1: Move shared components
mv src/components/BranchName.tsx src/shared/components/
mv src/components/OpenInDropdown.tsx src/shared/components/
mv src/components/ErrorBoundary.tsx src/shared/components/
mv src/components/content/empty-state.tsx src/shared/components/EmptyState.tsx
mv src/components/error-fallbacks/ src/shared/components/

# 3.2: Move shared hooks
mv src/hooks/useSocket.ts src/shared/hooks/
mv src/hooks/useKeyboardShortcuts.ts src/shared/hooks/
mv src/hooks/use-mobile.tsx src/shared/hooks/

# 3.3: Update imports in moved components
# In shared/components/BranchName.tsx:
# - import { cn } from '@/lib/utils'
# + import { cn } from '@/shared/lib/utils'

# In shared/components/OpenInDropdown.tsx:
# - import type { Workspace } from '@/types'
# + import type { Workspace } from '@/shared/types'  # Will update later to feature type
```

**Test after Phase 3:**
```bash
npm run build
```

### **PHASE 4: Migrate Feature - Terminal** (15 minutes)

**Why first:** Smallest, fewest dependencies, proves the pattern works

```bash
# 4.1: Move UI files
mv src/TerminalPanel.tsx src/features/terminal/ui/TerminalPanel.tsx
mv src/Terminal.tsx src/features/terminal/ui/Terminal.tsx
mv src/Terminal.css src/features/terminal/ui/Terminal.css

# 4.2: Create index files
cat > src/features/terminal/ui/index.ts << 'EOF'
export { TerminalPanel } from './TerminalPanel';
export { Terminal } from './Terminal';
EOF

cat > src/features/terminal/index.ts << 'EOF'
export { TerminalPanel, Terminal } from './ui';
EOF

# 4.3: Update imports in Terminal files
# In TerminalPanel.tsx:
# - import { Terminal } from './Terminal'
# + import { Terminal } from './Terminal'  # No change (relative import)

# 4.4: Create platform wrapper (optional for now)
# Create src/platform/tauri/commands/pty.ts later

# 4.5: Update imports in MainLayout (Dashboard.tsx)
# - import { TerminalPanel } from './TerminalPanel'
# + import { TerminalPanel } from '@/features/terminal'
```

**Test after Phase 4:**
```bash
npm run dev:full
# Open terminal tab - verify it works
```

### **PHASE 5: Migrate Feature - Browser** (15 minutes)

```bash
# 5.1: Move UI files
mv src/features/browser/components/BrowserPanel.tsx src/features/browser/ui/
mv src/features/browser/components/index.ts src/features/browser/ui/

# 5.2: Move hooks → rename to api/
mv src/features/browser/hooks/useDevBrowser.ts src/features/browser/hooks/useBrowser.ts

# 5.3: Create index files
cat > src/features/browser/hooks/index.ts << 'EOF'
export { useBrowser } from './useBrowser';
EOF

cat > src/features/browser/index.ts << 'EOF'
export { BrowserPanel } from './ui';
export { useBrowser } from './hooks';
EOF

# 5.4: Update imports in BrowserPanel.tsx
# - import { useDevBrowser } from '../hooks/useDevBrowser'
# + import { useBrowser } from '../hooks/useBrowser'

# 5.5: Update imports in MainLayout
# - import { BrowserPanel } from './features/browser/components'
# + import { BrowserPanel } from '@/features/browser'
```

**Test after Phase 5:**
```bash
npm run dev:full
# Open browser tab - verify it works
```

### **PHASE 6: Migrate Feature - Settings** (30 minutes)

```bash
# 6.1: Move UI files
mv src/features/dashboard/components/SettingsModal.tsx src/features/settings/ui/
mv src/features/dashboard/components/settings-sections/ src/features/settings/ui/sections/

# 6.2: Move API layer
mv src/hooks/queries/useSettingsQueries.ts src/features/settings/api/settings.queries.ts
mv src/services/settings.service.ts src/features/settings/api/settings.service.ts
mv src/services/memory.service.ts src/features/settings/api/memory.service.ts

# 6.3: Move types
mv src/types/settings.types.ts src/features/settings/types.ts

# 6.4: Create index files
cat > src/features/settings/ui/index.ts << 'EOF'
export { SettingsModal } from './SettingsModal';
EOF

cat > src/features/settings/api/index.ts << 'EOF'
export * from './settings.queries';
EOF

cat > src/features/settings/index.ts << 'EOF'
export { SettingsModal } from './ui';
export * from './api';
export type * from './types';
EOF

# 6.5: Update imports in SettingsModal.tsx
# - import { useSettings } from '@/hooks/queries'
# + import { useSettings } from '../api/settings.queries'

# - import { AccountSection } from './settings-sections'
# + import { AccountSection } from './sections'

# 6.6: Update imports in settings sections
# In sections/*.tsx:
# - import type { Settings } from '@/types'
# + import type { Settings } from '../../types'

# 6.7: Update imports in MainLayout
# - import { SettingsModal } from './features/dashboard/components'
# + import { SettingsModal } from '@/features/settings'
```

**Test after Phase 6:**
```bash
npm run dev:full
# Open settings modal - verify all tabs work
```

### **PHASE 7: Migrate Feature - Repository** (45 minutes)

```bash
# 7.1: Move UI files
mv src/features/dashboard/components/WelcomeView.tsx src/features/repository/ui/
mv src/features/dashboard/components/NewWorkspaceModal.tsx src/features/repository/ui/
mv src/features/dashboard/components/CloneRepositoryModal.tsx src/features/repository/ui/
mv src/features/dashboard/components/RepoGroup.tsx src/features/repository/ui/
mv src/features/dashboard/components/WorkspaceItem.tsx src/features/repository/ui/

# 7.2: Move API layer
mv src/hooks/queries/useRepoQueries.ts src/features/repository/api/repository.queries.ts
mv src/services/repo.service.ts src/features/repository/api/repository.service.ts

# 7.3: Move types
mv src/types/repo.types.ts src/features/repository/types.ts

# 7.4: Create index files
cat > src/features/repository/ui/index.ts << 'EOF'
export { WelcomeView } from './WelcomeView';
export { NewWorkspaceModal } from './NewWorkspaceModal';
export { CloneRepositoryModal } from './CloneRepositoryModal';
export { RepoGroup } from './RepoGroup';
export { WorkspaceItem } from './WorkspaceItem';
EOF

cat > src/features/repository/api/index.ts << 'EOF'
export * from './repository.queries';
EOF

cat > src/features/repository/index.ts << 'EOF'
export * from './ui';
export * from './api';
export type * from './types';
EOF

# 7.5: Update imports in repository UI files
# In WelcomeView.tsx, NewWorkspaceModal.tsx, etc.:
# - import { useRepos } from '@/hooks/queries'
# + import { useRepositories } from '../api/repository.queries'

# - import type { Repo } from '@/types'
# + import type { Repo } from '../types'

# - import { Button } from '@/components/ui/button'
# + import { Button } from '@/components/ui/button'  # No change

# 7.6: Update imports in repository.queries.ts
# - import { RepoService } from '@/services/repo.service'
# + import { RepoService } from './repository.service'

# - import { queryKeys } from '@/lib/queryKeys'
# + import { queryKeys } from '@/shared/api/queryKeys'

# 7.7: Update imports in MainLayout
# - import { WelcomeView, NewWorkspaceModal } from './features/dashboard/components'
# + import { WelcomeView, NewWorkspaceModal } from '@/features/repository'
```

**Test after Phase 7:**
```bash
npm run dev:full
# Test WelcomeView, create workspace, clone repo
```

### **PHASE 8: Migrate Feature - Workspace** (60 minutes)

**Most complex due to file changes extraction**

```bash
# 8.1: Move existing UI files
mv src/features/dashboard/components/DiffModal.tsx src/features/workspace/ui/

# 8.2: Extract FileChangesPanel from Dashboard
# Manual step: Create src/features/workspace/ui/FileChangesPanel.tsx
# Extract lines 600-678 from Dashboard.tsx
# Include Dev Servers + File Changes sections

# 8.3: Move API layer
mv src/hooks/queries/useWorkspaceQueries.ts src/features/workspace/api/workspace.queries.ts
mv src/services/workspace.service.ts src/features/workspace/api/workspace.service.ts

# 8.4: Move store
mv src/stores/workspaceStore.ts src/features/workspace/store/workspaceStore.ts

# 8.5: Move types
mv src/types/workspace.types.ts src/features/workspace/types.ts

# 8.6: Create index files
cat > src/features/workspace/ui/index.ts << 'EOF'
export { FileChangesPanel } from './FileChangesPanel';
export { DiffModal } from './DiffModal';
EOF

cat > src/features/workspace/api/index.ts << 'EOF'
export * from './workspace.queries';
EOF

cat > src/features/workspace/store/index.ts << 'EOF'
export { useWorkspaceStore } from './workspaceStore';
EOF

cat > src/features/workspace/index.ts << 'EOF'
export * from './ui';
export * from './api';
export * from './store';
export type * from './types';
EOF

# 8.7: Update imports in workspace files
# In workspace.queries.ts:
# - import { WorkspaceService } from '@/services/workspace.service'
# + import { WorkspaceService } from './workspace.service'

# - import { queryKeys } from '@/lib/queryKeys'
# + import { queryKeys } from '@/shared/api/queryKeys'

# In FileChangesPanel.tsx:
# - import { useFileChanges } from '@/hooks/queries'
# + import { useFileChanges } from '../api/workspace.queries'

# - import { useWorkspaceStore } from '@/stores'
# + import { useWorkspaceStore } from '../store/workspaceStore'

# 8.8: Update imports in MainLayout
# - import { DiffModal } from './features/dashboard/components'
# + import { DiffModal } from '@/features/workspace'

# - import { useWorkspaceStore } from './stores'
# + import { useWorkspaceStore } from '@/features/workspace'
```

**Test after Phase 8:**
```bash
npm run dev:full
# Select workspace, view file changes, open diff modal
```

### **PHASE 9: Migrate Feature - Session** (90 minutes)

**Largest migration - 40+ files**

```bash
# 9.1: Move main UI files
mv src/WorkspaceChatPanel.tsx src/features/session/ui/SessionPanel.tsx
mv src/features/workspace/components/Chat.tsx src/features/session/ui/
mv src/features/workspace/components/MessageInput.tsx src/features/session/ui/
mv src/features/workspace/components/MessageItem.tsx src/features/session/ui/
mv src/features/workspace/components/FileChangesPanel.tsx src/features/session/ui/

# 9.2: Move modals
mv src/features/dashboard/components/SystemPromptModal.tsx src/features/session/ui/

# 9.3: Move nested chat structure (40+ files)
mv src/features/workspace/components/chat/message/ src/features/session/ui/message/
mv src/features/workspace/components/chat/blocks/ src/features/session/ui/blocks/
mv src/features/workspace/components/chat/tools/ src/features/session/ui/tools/
mv src/features/workspace/components/chat/theme/ src/features/session/ui/theme/
mv src/features/workspace/components/chat/types.ts src/features/session/ui/chat-types.ts
mv src/features/workspace/components/chat/index.ts src/features/session/ui/chat-index.ts

# 9.4: Move API layer
mv src/hooks/queries/useSessionQueries.ts src/features/session/api/session.queries.ts
mv src/services/session.service.ts src/features/session/api/session.service.ts

# 9.5: Move hooks
mv src/hooks/useAutoScroll.ts src/features/session/hooks/

# 9.6: Move types
mv src/types/session.types.ts src/features/session/types.ts

# 9.7: Create index files
cat > src/features/session/ui/index.ts << 'EOF'
export { SessionPanel } from './SessionPanel';
export { Chat } from './Chat';
export { MessageInput } from './MessageInput';
export { SystemPromptModal } from './SystemPromptModal';
EOF

cat > src/features/session/api/index.ts << 'EOF'
export * from './session.queries';
EOF

cat > src/features/session/hooks/index.ts << 'EOF'
export { useAutoScroll } from './useAutoScroll';
EOF

cat > src/features/session/index.ts << 'EOF'
export { SessionPanel } from './ui';
export * from './api';
export type * from './types';
EOF

# 9.8: Update imports in SessionPanel.tsx (was WorkspaceChatPanel)
# - import { Chat, MessageInput } from './features/workspace/components'
# + import { Chat, MessageInput } from './ui'  # or '.'

# - import { useSessionWithMessages } from '@/hooks/queries'
# + import { useSessionWithMessages } from '../api/session.queries'

# - import { useAutoScroll } from '@/hooks'
# + import { useAutoScroll } from '../hooks/useAutoScroll'

# 9.9: Update imports in all nested files (blocks, tools, etc.)
# This is tedious but important:
# In blocks/*.tsx, tools/renderers/*.tsx:
# - import { ... } from '@/types'
# + import type { ... } from '../../../types'  # Adjust path based on depth

# - import { cn } from '@/lib/utils'
# + import { cn } from '@/shared/lib/utils'

# 9.10: Update imports in MainLayout
# - import { WorkspaceChatPanel } from './WorkspaceChatPanel'
# + import { SessionPanel } from '@/features/session'

# - import { SystemPromptModal } from './features/dashboard/components'
# + import { SystemPromptModal } from '@/features/session'
```

**Test after Phase 9:**
```bash
npm run dev:full
# Send messages, verify tools render, open system prompt modal
```

### **PHASE 10: Migrate Feature - Sidebar** (30 minutes)

```bash
# 10.1: Move sidebar UI
mv src/components/app-sidebar.tsx src/features/sidebar/ui/AppSidebar.tsx

# 10.2: Extract sidebar state from uiStore
# Manual step: Create src/features/sidebar/store/sidebarStore.ts
# Extract collapsedRepos, toggleRepoCollapse from uiStore

# 10.3: Update uiStore (keep only modal state)
# Edit src/stores/uiStore.ts - remove sidebar state
# Move to src/shared/stores/uiStore.ts

# 10.4: Create index files
cat > src/features/sidebar/ui/index.ts << 'EOF'
export { AppSidebar } from './AppSidebar';
EOF

cat > src/features/sidebar/store/index.ts << 'EOF'
export { useSidebarStore } from './sidebarStore';
EOF

cat > src/features/sidebar/index.ts << 'EOF'
export { AppSidebar } from './ui';
export { useSidebarStore } from './store';
EOF

# 10.5: Update imports in AppSidebar.tsx
# - import { useUIStore } from '@/stores'
# + import { useSidebarStore } from '../store/sidebarStore'

# - import type { Workspace } from '@/types'
# + import type { Workspace } from '@/features/workspace'

# 10.6: Update imports in MainLayout
# - import { AppSidebar } from './components/app-sidebar'
# + import { AppSidebar } from '@/features/sidebar'
```

**Test after Phase 10:**
```bash
npm run dev:full
# Verify sidebar shows, collapse/expand repos
```

### **PHASE 11: Create Platform Layer** (45 minutes)

```bash
# 11.1: Create socket wrapper
# Extract from src/services/socket.ts
cat > src/platform/tauri/socket/SocketClient.ts << 'EOF'
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export class SocketClient {
  async connect(path: string): Promise<void> {
    return invoke('socket_connect', { path });
  }

  async send(data: string): Promise<void> {
    return invoke('socket_send', { data });
  }

  async close(): Promise<void> {
    return invoke('socket_close');
  }

  onMessage(callback: (data: string) => void) {
    return listen('socket_message', (event) => {
      callback(event.payload as string);
    });
  }
}
EOF

# 11.2: Create command wrappers
cat > src/platform/tauri/commands/pty.ts << 'EOF'
import { invoke } from '@tauri-apps/api/core';

export const ptyCommands = {
  create: (workspacePath: string) =>
    invoke<string>('pty_create', { workspacePath }),

  write: (id: string, data: string) =>
    invoke('pty_write', { id, data }),

  resize: (id: string, cols: number, rows: number) =>
    invoke('pty_resize', { id, cols, rows }),

  close: (id: string) =>
    invoke('pty_close', { id }),
};
EOF

cat > src/platform/tauri/commands/socket.ts << 'EOF'
import { invoke } from '@tauri-apps/api/core';

export const socketCommands = {
  connect: (path: string) =>
    invoke('socket_connect', { path }),

  send: (data: string) =>
    invoke('socket_send', { data }),

  close: () =>
    invoke('socket_close'),
};
EOF

# 11.3: Create platform index
cat > src/platform/tauri/commands/index.ts << 'EOF'
export * from './pty';
export * from './socket';
EOF

cat > src/platform/tauri/index.ts << 'EOF'
export * from './commands';
export { SocketClient } from './socket/SocketClient';
EOF

cat > src/platform/index.ts << 'EOF'
export * from './tauri';
EOF

# 11.4: Update Terminal to use platform layer
# In features/terminal/ui/Terminal.tsx:
# - import { invoke } from '@tauri-apps/api/core'
# - await invoke('pty_write', { id, data })
# + import { ptyCommands } from '@/platform/tauri'
# + await ptyCommands.write(id, data)
```

**Test after Phase 11:**
```bash
npm run dev:full
# Test terminal, verify PTY commands work through wrapper
```

### **PHASE 12: Migrate App Layer** (60 minutes)

```bash
# 12.1: Extract QueryClientProvider
cat > src/app/providers/QueryClientProvider.tsx << 'EOF'
import { ReactNode } from 'react';
import { QueryClientProvider as TanStackProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '@/shared/api/queryClient';

interface QueryClientProviderProps {
  children: ReactNode;
}

export function QueryClientProvider({ children }: QueryClientProviderProps) {
  return (
    <TanStackProvider client={queryClient}>
      {children}
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </TanStackProvider>
  );
}
EOF

# 12.2: Extract ThemeProvider
# Move src/hooks/useTheme.tsx → src/app/providers/ThemeProvider.tsx
mv src/hooks/useTheme.tsx src/app/providers/ThemeProvider.tsx
# Keep both ThemeProvider component and useTheme hook in same file

# 12.3: Create providers index
cat > src/app/providers/index.ts << 'EOF'
export { QueryClientProvider } from './QueryClientProvider';
export { ThemeProvider, useTheme } from './ThemeProvider';
EOF

# 12.4: Extract WorkspaceHeader
cat > src/app/layouts/components/WorkspaceHeader.tsx << 'EOF'
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { BranchName } from '@/shared/components/BranchName';
import { OpenInDropdown } from '@/shared/components/OpenInDropdown';

interface WorkspaceHeaderProps {
  branch: string;
  workspacePath: string;
}

export function WorkspaceHeader({ branch, workspacePath }: WorkspaceHeaderProps) {
  return (
    <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm px-4 py-3 elevation-1 flex-shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <BranchName branch={branch} />
        </div>
        <OpenInDropdown workspacePath={workspacePath} />
      </div>
    </div>
  );
}
EOF

# 12.5: Move and refactor Dashboard → MainLayout
mv src/Dashboard.tsx src/app/layouts/MainLayout.tsx

# 12.6: Update MainLayout imports (MAJOR REFACTOR)
# This is the biggest change - update ALL imports to new paths:

# OLD IMPORTS:
# - import { WorkspaceChatPanel } from "./WorkspaceChatPanel";
# - import { TerminalPanel } from "./TerminalPanel";
# - import { BrowserPanel } from "./features/browser/components";
# - import { NewWorkspaceModal, SettingsModal, WelcomeView } from "./features/dashboard/components";
# - import { AppSidebar } from "./components/app-sidebar";
# - import { useWorkspaceStore } from "./stores";

# NEW IMPORTS:
# + import { SessionPanel } from '@/features/session';
# + import { TerminalPanel } from '@/features/terminal';
# + import { BrowserPanel } from '@/features/browser';
# + import { FileChangesPanel } from '@/features/workspace';
# + import { AppSidebar } from '@/features/sidebar';
# + import { WelcomeView, NewWorkspaceModal } from '@/features/repository';
# + import { SettingsModal } from '@/features/settings';
# + import { DiffModal, SystemPromptModal } from '@/features/workspace'; (or session)
# + import { useWorkspaceStore } from '@/features/workspace';
# + import { WorkspaceHeader } from './components/WorkspaceHeader';

# Also:
# - Replace inline FileChanges rendering (lines 600-678) with <FileChangesPanel />
# - Use WorkspaceHeader component instead of inline header

# 12.7: Move App.tsx
mv src/App.tsx src/app/App.tsx

# 12.8: Update App.tsx
# - import { Dashboard } from "./Dashboard"
# + import { MainLayout } from "./layouts/MainLayout"

# - import { ThemeProvider } from "./hooks/useTheme"
# + import { ThemeProvider } from "./providers/ThemeProvider"

# - import { QueryClientProvider } from "@tanstack/react-query"
# - import { queryClient } from "./lib/queryClient"
# + import { QueryClientProvider } from "./providers/QueryClientProvider"

# Simplify to:
# <QueryClientProvider>
#   <ThemeProvider>
#     <BrowserRouter>
#       <Routes>
#         <Route path="/" element={<MainLayout />} />
#       </Routes>
#     </BrowserRouter>
#   </ThemeProvider>
# </QueryClientProvider>

# 12.9: Move main.tsx
mv src/main.tsx src/app/main.tsx

# Update import if needed:
# - import App from "./App"
# + import App from "./App"  # No change (same directory)
```

**Test after Phase 12:**
```bash
npm run dev:full
# Full app test - all features should work
```

### **PHASE 13: Final Cleanup** (20 minutes)

```bash
# 13.1: Move styles
mv src/styles.css src/styles/styles.css
mv src/fonts.css src/styles/fonts.css

# 13.2: Update index.html to reference new main.tsx location
# Edit index.html:
# - <script type="module" src="/src/main.tsx"></script>
# + <script type="module" src="/src/app/main.tsx"></script>

# 13.3: Delete old files
rm src/hooks/useDashboardData.ts
rm src/hooks/useWorkspaces.ts
rm src/hooks/useDiffStats.ts
rm src/hooks/useFileChanges.ts
rm src/hooks/useMessages.ts

# 13.4: Delete old directories (verify empty first)
rmdir src/config
rmdir src/services
rmdir src/stores/
rmdir src/types/
rmdir src/utils/
rmdir src/lib/
rmdir src/hooks/queries
rmdir src/hooks/
rmdir src/features/dashboard/
rmdir src/features/workspace/

# 13.5: Update vite.config.ts path alias (if needed)
# Verify resolve.alias or tsconfig.json paths include @/app, @/features, etc.
```

### **PHASE 14: Validation** (30 minutes)

```bash
# 14.1: TypeScript compilation
npm run build
# Should compile with 0 errors

# 14.2: Check for old import patterns
echo "Checking for old import patterns..."

grep -r "@/hooks/queries" src/ | grep -v "node_modules" | grep -v ".ts:" || echo "✅ No old hooks/queries imports"
grep -r "@/services/" src/ | grep -v "node_modules" || echo "✅ No old services imports"
grep -r "@/stores" src/ | grep -v "node_modules" | grep -v "@/shared/stores" || echo "✅ No old stores imports"
grep -r "@/types" src/ | grep -v "node_modules" | grep -v "@/shared/types" || echo "✅ No old types imports"

# 14.3: Full app testing
npm run dev:full

# Test checklist:
# ✅ App loads
# ✅ Sidebar shows repositories
# ✅ WelcomeView displays when no workspace selected
# ✅ Create new workspace works
# ✅ Clone repository works
# ✅ Select workspace → SessionPanel appears
# ✅ Send message → receives response
# ✅ Tool renderers display correctly
# ✅ File changes panel shows files
# ✅ Diff modal opens
# ✅ Browser panel loads
# ✅ Terminal works
# ✅ Settings modal opens, all sections work
# ✅ Keyboard shortcuts work
# ✅ No console errors

# 14.4: Production build
npm run build
npm run preview
# Test in production build
```

---

## 📝 IMPORT UPDATE PATTERNS

### **Feature Imports**

```typescript
// ✅ GOOD: Import from feature's public API
import { SessionPanel } from '@/features/session'
import { useWorkspaces } from '@/features/workspace'
import { SettingsModal } from '@/features/settings'

// ❌ BAD: Reach into feature internals
import { SessionPanel } from '@/features/session/ui/SessionPanel'
import { useWorkspaceStore } from '@/features/workspace/store/workspaceStore'
```

### **Shared Imports**

```typescript
// ✅ Services/API
import { apiClient } from '@/shared/api/client'
import { queryClient } from '@/shared/api/queryClient'

// ✅ Components
import { BranchName } from '@/shared/components/BranchName'
import { ErrorBoundary } from '@/shared/components/ErrorBoundary'

// ✅ Hooks
import { useKeyboardShortcuts } from '@/shared/hooks'
import { useSocket } from '@/shared/hooks'

// ✅ Lib/Utils
import { cn } from '@/shared/lib/utils'
import { formatTokenCount } from '@/shared/lib/formatters'

// ✅ Types
import type { ApiError } from '@/shared/types'

// ✅ Stores (only global UI state)
import { useUIStore } from '@/shared/stores/uiStore'
```

### **App Imports**

```typescript
// ✅ Config
import { API_CONFIG } from '@/app/config/api.config'

// ✅ Providers
import { QueryClientProvider } from '@/app/providers'
import { ThemeProvider, useTheme } from '@/app/providers'

// ✅ Layout
import { MainLayout } from '@/app/layouts/MainLayout'
```

### **Platform Imports**

```typescript
// ✅ Tauri commands
import { ptyCommands } from '@/platform/tauri/commands'
import { socketCommands } from '@/platform/tauri/commands'
import { SocketClient } from '@/platform/tauri'

// ❌ Direct Tauri imports (only in platform layer)
// Don't do this outside platform/:
import { invoke } from '@tauri-apps/api/core'
```

### **Within-Feature Imports**

```typescript
// When in features/session/ui/SessionPanel.tsx:

// ✅ Relative imports within same feature
import { Chat } from './Chat'
import { MessageInput } from './MessageInput'
import { useSessionWithMessages } from '../api/session.queries'
import { useAutoScroll } from '../hooks/useAutoScroll'
import type { Message } from '../types'

// ✅ External imports
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/lib/utils'
import type { Workspace } from '@/features/workspace'
```

---

## ✅ VALIDATION & TESTING

### **Pre-Migration Checklist**

- [ ] Git commit all changes: `git add . && git commit -m "pre-refactor checkpoint"`
- [ ] Create backup branch: `git branch backup-pre-refactor`
- [ ] Current build succeeds: `npm run build`
- [ ] Current dev server works: `npm run dev:full`
- [ ] Document current working features (screenshot tests)

### **During Migration (After Each Phase)**

- [ ] TypeScript compiles: `npm run build`
- [ ] No broken imports: `grep -r "from '@/services" src/` (should be empty after certain phases)
- [ ] Dev server starts: `npm run dev:full`
- [ ] Basic feature works (varies per phase)

### **Post-Migration Checklist**

#### **Build & Compilation**
- [ ] TypeScript compiles: `npm run build` (0 errors)
- [ ] No old import patterns detected
- [ ] Production build works: `npm run preview`

#### **Feature Testing**

**Navigation & Layout:**
- [ ] App loads without errors
- [ ] Sidebar visible and collapsible
- [ ] Repositories display in sidebar
- [ ] Workspace items display with correct status

**Repository Management:**
- [ ] WelcomeView displays when no workspace selected
- [ ] "Create Workspace" button opens modal
- [ ] "Clone Repository" modal works
- [ ] "Open Project" folder picker works
- [ ] Creating workspace succeeds
- [ ] New workspace appears in sidebar

**Workspace Management:**
- [ ] Select workspace → main content updates
- [ ] Workspace header shows branch name
- [ ] "Open In" dropdown works (Finder, VS Code)
- [ ] File changes panel shows changed files
- [ ] Diff stats display (+/- counts)
- [ ] Click file → diff modal opens
- [ ] Archive workspace works

**Session (Chat):**
- [ ] SessionPanel loads when workspace selected
- [ ] Message input accepts text
- [ ] Send message → receives response
- [ ] Messages render correctly
- [ ] Thinking blocks animate
- [ ] Tool use blocks display
- [ ] Tool result blocks display
- [ ] All tool renderers work:
  - [ ] BashToolRenderer
  - [ ] ReadToolRenderer
  - [ ] WriteToolRenderer
  - [ ] EditToolRenderer
  - [ ] GrepToolRenderer
  - [ ] GlobToolRenderer
- [ ] System prompt modal opens and saves
- [ ] Auto-scroll to bottom works
- [ ] Scroll to bottom button appears when needed

**Terminal:**
- [ ] Terminal panel opens in right panel
- [ ] XTerm loads
- [ ] Can type commands
- [ ] Commands execute
- [ ] Output displays
- [ ] Terminal resizes correctly

**Browser:**
- [ ] Browser panel opens in right panel
- [ ] Dev server URLs display
- [ ] Can navigate in browser
- [ ] Element selector works (if applicable)

**Settings:**
- [ ] Settings modal opens
- [ ] All sections accessible:
  - [ ] Account section
  - [ ] General section
  - [ ] Terminal section
  - [ ] Memory section
  - [ ] Provider section
- [ ] Settings save successfully
- [ ] Clear memory works

**Global Features:**
- [ ] Keyboard shortcuts work (Cmd+R refresh, etc.)
- [ ] Theme toggle works (if applicable)
- [ ] WebSocket connection establishes
- [ ] TanStack Query fetching works
- [ ] No console errors

#### **Code Quality Checks**

```bash
# No old import patterns
! grep -r "@/hooks/queries" src/ --exclude-dir=node_modules
! grep -r "@/services/" src/ --exclude-dir=node_modules | grep -v "@/shared/api/services"
! grep -r "from '@/stores'" src/ --exclude-dir=node_modules | grep -v "@/shared/stores"

# No direct Tauri imports outside platform/
! grep -r "from '@tauri-apps/api/core'" src/ --exclude-dir=node_modules --exclude-dir=platform

# All features have index.ts
test -f src/features/repository/index.ts
test -f src/features/workspace/index.ts
test -f src/features/session/index.ts
test -f src/features/terminal/index.ts
test -f src/features/browser/index.ts
test -f src/features/settings/index.ts
test -f src/features/sidebar/index.ts
```

---

## 🔙 ROLLBACK PLAN

### **Option 1: Full Rollback**

```bash
# Discard all changes, return to backup
git checkout backup-pre-refactor
```

### **Option 2: Partial Rollback**

```bash
# Rollback specific phase
git log --oneline  # Find commit before problematic phase
git reset --hard <commit-hash>
```

### **Option 3: Cherry-Pick Recovery**

```bash
# If you need to keep some changes
git log --oneline
git cherry-pick <commit-hash>  # Pick specific good commits
```

---

## 📊 SUMMARY STATISTICS

| Metric | Before | After |
|--------|--------|-------|
| **Total files** | 141 | ~155 (with new index files) |
| **Top-level files** | 7 | 0 (all organized) |
| **Features** | 3 (poorly defined) | 7 (well-defined domains) |
| **Deleted files** | - | 9 (old hooks) |
| **New files** | - | ~25 (index, platform, etc.) |
| **Import paths updated** | - | ~100+ files |
| **Lines in Dashboard** | 749 | ~300 (target) |

---

## 🎯 SUCCESS CRITERIA

### **Architectural Goals**

✅ **Domain-driven features** - Each feature represents a business domain
✅ **Vertical slices** - Features own UI + API + state + types
✅ **Platform abstraction** - Tauri code centralized and testable
✅ **Public APIs** - Features export only public APIs via index.ts
✅ **Minimal shared** - Only truly cross-cutting code in shared/
✅ **No old patterns** - All old hooks deleted, only TanStack Query

### **Developer Experience**

✅ **Easy to find** - "Where's workspace code?" → `features/workspace/`
✅ **Easy to add** - Clear pattern to follow for new features
✅ **Easy to test** - Features can be tested in isolation
✅ **Easy to understand** - Clear boundaries and dependencies

### **Code Quality**

✅ **No circular dependencies**
✅ **Type-safe imports**
✅ **No broken imports**
✅ **Build succeeds**
✅ **All tests pass**

---

## 📚 REFERENCE

### **Decision Tree: "Where Does Code Go?"**

```
❓ Is it a shadcn/ui component?
   → components/ui/

❓ Is it Tauri-specific (invoke, events)?
   → platform/tauri/

❓ Is it used by 3+ features AND has no domain?
   → shared/

❓ Does it belong to a business domain (repo, workspace, session)?
   → features/{domain}/

   ❓ Is it UI?
      → features/{domain}/ui/

   ❓ Is it data fetching?
      → features/{domain}/api/

   ❓ Is it domain state?
      → features/{domain}/store/

   ❓ Is it domain-specific logic?
      → features/{domain}/hooks/

❓ Is it app-level setup (providers, layout)?
   → app/
```

### **Glossary**

- **Domain** - Business capability (repository management, workspace management, chat sessions)
- **Feature** - Vertical slice owning all code for a domain
- **Vertical Slice** - UI + API + State + Types for one feature
- **Platform Layer** - Abstraction over platform-specific code (Tauri, Electron)
- **Public API** - What a feature exports via index.ts
- **Shared** - Truly cross-cutting code with no domain

---

**End of Refactoring Plan v2.0**

---

## 🚀 READY TO EXECUTE

This plan is **fully self-contained** and can be executed even after context compaction.

**To begin migration:**
1. Review this plan
2. Approve structure
3. Execute phase-by-phase (start with Phase 0)
4. Test after each phase
5. Commit frequently

**Estimated Time:** 6-8 hours for complete migration

**Risk Level:** Low (fully reversible, phased approach)

**Success Rate:** High (proven pattern, detailed steps)
