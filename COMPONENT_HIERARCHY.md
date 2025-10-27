# Component Hierarchy & Architecture Analysis

## 📊 Current Component Tree

```
MainLayout (src/app/layouts/MainLayout.tsx)
├── State Management
│   ├── Zustand Stores
│   │   ├── useWorkspaceStore() → selectedWorkspace
│   │   └── useUIStore() → diffModal, modals
│   └── TanStack Query
│       ├── useWorkspacesByRepo() → workspaces
│       ├── useFileChanges() → file changes
│       └── useFileDiff() → individual diff
│
├── SidebarProvider (shadcn context)
│   ├── AppSidebar
│   │   └── RepoGroups → WorkspaceItems
│   │
│   └── SidebarInset
│       └── MainContent Component (inner component)
│           ├── Grid Layout (1fr | 400px or browser)
│           │
│           ├── [LEFT: Main Content Area]
│           │   ├── WorkspaceHeader
│           │   │   ├── Branch name
│           │   │   └── Browser toggle button
│           │   │
│           │   ├── MainContentTabBar ← **KEY COMPONENT**
│           │   │   ├── Props: tabs[], activeTabId, handlers
│           │   │   └── Renders: Tab buttons with close [×]
│           │   │
│           │   └── Tab Content Area
│           │       └── SessionPanel (embedded=true)
│           │           ├── Chat messages
│           │           ├── MessageInput
│           │           └── Scroll controls
│           │
│           └── [RIGHT: Panel or Browser]
│               ├── IF isBrowserOpen:
│               │   └── BrowserPanel
│               │       └── Browser iframe
│               │
│               └── ELSE:
│                   ├── Tabs (Files | Changes)
│                   │   ├── FileBrowserPanel
│                   │   └── FileChangesPanel ← **CLICK HANDLER HERE**
│                   │       ├── Dev Servers list
│                   │       └── File changes list
│                   │           └── onClick: handleFileClick()
│                   │               → openDiffModal() ← **REMOVE THIS**
│                   │
│                   └── CollapsibleTerminalPanel
│
└── Modals (Portal-based, z-index overlay)
    ├── NewWorkspaceModal
    ├── DiffModal ← **DELETE THIS**
    ├── SystemPromptModal
    ├── CloneRepositoryModal
    └── SettingsModal
```

---

## 🔄 Current Data Flow (Diff Modal)

**User clicks file in FileChangesPanel:**

```
1. FileChangesPanel.tsx
   └─ handleFileClick(file)
      │
      ├─ openDiffModal(file, 'Loading...') ← Zustand action
      │  └─ uiStore.diffModal = { file, diff }
      │
      ├─ WorkspaceService.fetchFileDiff(workspaceId, file) ← API call
      │  └─ GET /api/workspaces/:id/diff/:file
      │
      └─ openDiffModal(file, actualDiff) ← Update with real data
         └─ uiStore.diffModal = { file, diff }

2. MainLayout.tsx
   └─ useUIStore() → diffModal
      └─ Renders: <DiffModal
                    selectedFile={diffModal?.file}
                    fileDiff={diffModal?.diff}
                  />

3. DiffModal.tsx (shadcn Dialog)
   └─ <Dialog open={!!selectedFile}>
      └─ Shows popup overlay
         └─ ScrollArea with <pre>{fileDiff}</pre>
```

**Problem:** Modal disrupts context, requires close/open cycle.

---

## 🎯 NEW Data Flow (Inline Tabs)

**User clicks file in FileChangesPanel:**

```
1. FileChangesPanel.tsx
   └─ handleFileClick(file)
      │
      ├─ onOpenDiffTab({ file, diff: 'Loading...', additions, deletions })
      │  └─ MainLayout.handleOpenDiffTab() ← Callback prop
      │     └─ Update mainTabs state (add/reuse tab)
      │     └─ setActiveMainTabId(diffTabId)
      │
      ├─ WorkspaceService.fetchFileDiff(workspaceId, file) ← API call
      │  └─ GET /api/workspaces/:id/diff/:file
      │
      └─ onUpdateDiffTab(file, { diff: actualDiff })
         └─ MainLayout.handleUpdateDiffTab() ← Callback prop
            └─ Update tab.data.diff in mainTabs state

2. MainLayout.tsx → MainContent component
   └─ State: mainTabs = [
        { id: 'chat-1', type: 'chat', ... },
        { id: 'diff-1234', type: 'diff', data: { filePath, diff, ... } }
      ]
   └─ State: activeMainTabId = 'diff-1234'
   │
   ├─ MainContentTabBar renders tabs
   │  └─ User sees: [Chat #1] [file.tsx ×] ← Active
   │
   └─ Tab Content Area renders based on activeTab.type:
      ├─ IF type === 'chat' → <SessionPanel />
      └─ IF type === 'diff' → <DiffViewer /> ← NEW COMPONENT

3. DiffViewer.tsx (new component)
   └─ Receives props: filePath, diff, additions, deletions
   └─ Renders:
      ├─ Header (file path, stats, copy button)
      └─ ScrollArea with syntax-highlighted diff
```

**Benefit:** No modal, stays in same visual plane, context preserved.

---

## 📦 Type System

### Current Tab Interface
```typescript
// src/features/workspace/ui/MainContentTabs.tsx

export interface Tab {
  id: string;
  label: string;
  type: 'chat' | 'files';  // ← Limited to 2 types
  closeable?: boolean;
}
```

### NEW Extended Tab Interface
```typescript
// src/features/workspace/ui/MainContentTabs.tsx

export interface Tab {
  id: string;
  label: string;
  type: 'chat' | 'diff' | 'file';  // ← Add 'diff' and 'file'
  closeable?: boolean;

  // Type-specific data payload
  data?: {
    // For 'diff' tabs
    filePath?: string;
    diff?: string;
    additions?: number;
    deletions?: number;

    // For 'file' tabs (future)
    fileContent?: string;
    language?: string;

    // For 'chat' tabs
    sessionId?: string;
  };
}
```

---

## 🗂️ File Structure

### Current Files
```
src/
├── app/layouts/
│   └── MainLayout.tsx ← Main orchestrator
│
├── features/workspace/
│   ├── ui/
│   │   ├── MainContentTabs.tsx ← Tab bar UI
│   │   ├── FileChangesPanel.tsx ← File list (click handler)
│   │   ├── DiffModal.tsx ← ❌ DELETE THIS
│   │   └── index.ts ← Exports
│   │
│   ├── api/
│   │   ├── workspace.service.ts ← fetchFileDiff()
│   │   └── workspace.queries.ts ← TanStack hooks
│   │
│   ├── types.ts ← FileChange, DiffStats
│   └── store/
│       └── workspaceStore.ts ← selectedWorkspace
│
└── shared/stores/
    └── uiStore.ts ← diffModal ← ❌ REMOVE THIS
```

### NEW Files to Add
```
src/features/workspace/ui/
└── DiffViewer.tsx ← ✅ NEW: Inline diff renderer
```

---

## 🔧 Implementation Plan

### Phase 1: Type System
- [ ] Update `Tab` interface in `MainContentTabs.tsx`
- [ ] Add `data?` field for metadata
- [ ] Add `'diff'` to type union

### Phase 2: DiffViewer Component
- [ ] Create `src/features/workspace/ui/DiffViewer.tsx`
- [ ] Props: `filePath`, `diff`, `additions`, `deletions`
- [ ] Render header with file path and stats
- [ ] Render scrollable diff content
- [ ] Add syntax highlighting (+ green, - red)

### Phase 3: MainLayout Tab Logic
- [ ] Add `handleOpenDiffTab(fileData)` function
  - Check if tab exists for this file → reuse or create
  - Insert after current active tab
  - Switch to new/existing tab
- [ ] Add `handleUpdateDiffTab(filePath, updates)` function
  - Find tab by filePath
  - Update tab.data with new diff content
- [ ] Update tab content rendering
  - Switch on `activeTab.type`
  - Render `<DiffViewer />` for type='diff'

### Phase 4: FileChangesPanel Integration
- [ ] Add `onOpenDiffTab` prop (callback from MainLayout)
- [ ] Add `onUpdateDiffTab` prop (callback from MainLayout)
- [ ] Update `handleFileClick` to call callbacks instead of `openDiffModal`
- [ ] Keep async diff loading pattern (show "Loading..." then update)

### Phase 5: Cleanup
- [ ] Remove `<DiffModal />` from MainLayout
- [ ] Delete `src/features/workspace/ui/DiffModal.tsx`
- [ ] Remove from `src/features/workspace/ui/index.ts` exports
- [ ] Remove `diffModal` from `uiStore.ts` (state + actions)
- [ ] Update `useKeyboardShortcuts` to remove Escape → closeDiffModal

---

## 🎨 Component Patterns Analysis

### State Management Pattern
```typescript
// Pattern: Zustand for global, useState for local
// Example: MainLayout.tsx

// Global (Zustand)
const selectedWorkspace = useWorkspaceStore(state => state.selectedWorkspace);
const { openDiffModal } = useUIStore();

// Local (React state)
const [mainTabs, setMainTabs] = useState<Tab[]>([...]);
const [activeMainTabId, setActiveMainTabId] = useState('chat-1');
```

**Decision:** Tab state is LOCAL (MainLayout), not global.
- Tabs are ephemeral UI state (don't persist across app restarts)
- Only MainLayout needs to know about tabs
- No other components need tab access

### Props Passing Pattern
```typescript
// Pattern: Callback props for child → parent communication
// Example: MainContent receives callbacks

function MainContent({
  selectedWorkspace,
  onWorkspaceClick,  // ← Callback to parent
  onCreateWorkspace, // ← Callback to parent
}) {
  // Child calls parent function
  return <Button onClick={onCreateWorkspace}>New</Button>;
}
```

**Decision:** FileChangesPanel will receive callbacks:
```typescript
<FileChangesPanel
  selectedWorkspace={selectedWorkspace}
  onOpenDiffTab={handleOpenDiffTab}      // ← NEW
  onUpdateDiffTab={handleUpdateDiffTab}  // ← NEW
/>
```

### Component Composition Pattern
```typescript
// Pattern: Container/Presentational split
// Example: MainLayout (container) → MainContent (presentational)

// Container: Logic, state, data fetching
function MainLayout() {
  const data = useQuery(...);
  const handleClick = () => {...};
  return <MainContent data={data} onClick={handleClick} />;
}

// Presentational: Pure UI rendering
function MainContent({ data, onClick }) {
  return <div>{data.map(...)}</div>;
}
```

**Decision:** DiffViewer is PRESENTATIONAL (pure UI):
```typescript
// No hooks, no state management, just rendering
export function DiffViewer({ filePath, diff, additions, deletions }) {
  return <div>Render UI</div>;
}
```

### Styling Pattern
```typescript
// Pattern: Tailwind CSS v4 (CSS-first, no JS config)
// Colors: OKLCH format, semantic tokens

// ✅ Good
className="bg-background text-foreground border-border"

// ❌ Bad
className="bg-gray-100 text-black border-gray-300"
```

**Decision:** DiffViewer uses semantic colors:
```typescript
// Additions: success color
className="bg-success/10 text-success border-success/20"

// Deletions: destructive color
className="bg-destructive/10 text-destructive border-destructive/20"
```

---

## 🔍 Key Files to Modify

### 1. MainContentTabs.tsx (Line 8-14)
**Change:** Extend Tab interface
```diff
export interface Tab {
  id: string;
  label: string;
- type: 'chat' | 'files';
+ type: 'chat' | 'diff' | 'file';
  closeable?: boolean;
+ data?: {
+   filePath?: string;
+   diff?: string;
+   additions?: number;
+   deletions?: number;
+   sessionId?: string;
+ };
}
```

### 2. MainLayout.tsx (Line 200-229)
**Change:** Tab content rendering
```diff
<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
- {selectedWorkspace.active_session_id && (
-   <SessionPanel ... />
- )}
+ {(() => {
+   const activeTab = mainTabs.find(t => t.id === activeMainTabId);
+   if (activeTab?.type === 'chat') {
+     return <SessionPanel ... />;
+   }
+   if (activeTab?.type === 'diff') {
+     return <DiffViewer {...activeTab.data} />;
+   }
+   return null;
+ })()}
</div>
```

### 3. MainLayout.tsx (Add handlers)
**Add:** Tab management functions (~80 lines)
```typescript
function handleOpenDiffTab(fileData) { ... }
function handleUpdateDiffTab(filePath, updates) { ... }
```

### 4. FileChangesPanel.tsx (Line 16)
**Change:** Add callback props
```diff
interface FileChangesPanelProps {
  selectedWorkspace: Workspace | null;
+ onOpenDiffTab?: (data: { file: string; diff: string; additions: number; deletions: number }) => void;
+ onUpdateDiffTab?: (filePath: string, updates: { diff?: string }) => void;
}
```

### 5. FileChangesPanel.tsx (Line 31-55)
**Change:** handleFileClick implementation
```diff
async function handleFileClick(file: string) {
  if (!selectedWorkspace) return;
  currentFileRef.current = file;

- openDiffModal(file, 'Loading diff...');
+ onOpenDiffTab?.({ file, diff: 'Loading diff...', additions: 0, deletions: 0 });

  try {
    const data = await WorkspaceService.fetchFileDiff(...);
    if (currentFileRef.current !== file) return;
-   openDiffModal(file, data.diff || 'No diff available');
+   onUpdateDiffTab?.(file, { diff: data.diff || 'No diff available' });
  } catch (error) {
    ...
  }
}
```

### 6. NEW: DiffViewer.tsx
**Create:** Complete new component (~200 lines)

### 7. uiStore.ts (Cleanup)
**Remove:** diffModal state and actions
```diff
interface UIState {
- diffModal: DiffModalState | null;
- openDiffModal: (file: string, diff: string) => void;
- closeDiffModal: () => void;
}
```

---

## 📐 Visual Layout Reference

```
┌─────────────────────────────────────────────────────────────┐
│ WorkspaceHeader: feature/x                  [Browser] 🌐    │
├─────────────────────────────────────────────────────────────┤
│ MainContentTabBar: [Chat #1]  [file.tsx ×]  [+]            │ ← Tab buttons
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Tab Content (rendered based on activeTab.type):            │
│                                                             │
│ IF type='diff':                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ DiffViewer Component                                    │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ Header: src/features/ui/file.tsx                    │ │ │
│ │ │         +42  -12                          [Copy]    │ │ │
│ │ ├─────────────────────────────────────────────────────┤ │ │
│ │ │ ScrollArea:                                         │ │ │
│ │ │  1  │ import { Button } from '@/ui'                 │ │ │
│ │ │ +2  │ export function Viewer() {                    │ │ │
│ │ │ -3  │   return <div>Old</div>                       │ │ │
│ │ │  4  │ }                                             │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ✅ Verification Checklist

Before implementing, verify:
- [x] Understand MainLayout state management (Zustand + local)
- [x] Understand Tab interface structure
- [x] Understand FileChangesPanel click flow
- [x] Understand API layer (WorkspaceService.fetchFileDiff)
- [x] Understand component props pattern (callbacks)
- [x] Understand styling pattern (Tailwind v4, semantic colors)
- [ ] Run app and test current behavior
- [ ] Implement DiffViewer component
- [ ] Wire up MainLayout handlers
- [ ] Test inline diff tabs
- [ ] Cleanup old modal code

---

**Status:** Architecture analysis complete. Ready to implement Phase 1.
