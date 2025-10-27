# Inline Diff Viewer Feature Exploration

## 🎯 Vision

Transform file diff viewing from a **disruptive modal popup** into a **seamless inline tab experience** within the chat session area. When users click a file change, the diff opens as a tab next to chat sessions, maintaining context and spatial consistency.

---

## 🎨 UX Design Philosophy

### Design Principles (Linear, Stripe, Airbnb, Jony Ive)

**1. Minimalism - Remove Visual Noise**
- No modal overlays interrupting the workflow
- Diffs live in the same visual plane as chat
- One unified interaction model: tabs

**2. Context Preservation - Stay in Flow**
- Keep chat and diff visible together (switch via tabs, not close/open)
- No cognitive load of "where did my chat go?"
- Multi-task naturally: compare diff while referencing chat messages

**3. Spatial Consistency - Predictable Layouts**
- Everything lives in the main content area (left side of grid)
- Right panel remains accessible for additional context
- No Z-axis disruption (modals breaking the plane)

**4. Fluidity - Smooth Transitions**
- Tabs slide in with subtle animation (200-300ms ease-out)
- Active indicators guide the eye
- No jarring popups or layout shifts

**5. Purposeful Design - Intentional Hierarchy**
```
┌─────────────────────────────────────┐
│ Branch: feature/x     [Browser] 🌐 │
├─────────────────────────────────────┤
│ Chat #1  │  Diff: file.tsx  │  [+] │ ← Tab Bar
├─────────────────────────────────────┤
│                                     │
│    [Active Tab Content]             │
│    - Chat messages OR               │
│    - Diff viewer OR                 │
│    - Full file viewer               │
│                                     │
└─────────────────────────────────────┘
```

---

## 🔧 Technical Architecture

### Current State

**File Click Flow:**
```
FileChangesPanel.tsx
  → handleFileClick(file)
  → openDiffModal(file, diff)  ← Zustand store
  → DiffModal renders as Dialog ❌ (popup)
```

**Tab System:**
```typescript
// MainContentTabs.tsx
interface Tab {
  id: string;
  label: string;
  type: 'chat' | 'files';  // ← Limited types
  closeable?: boolean;
}
```

---

### Proposed Architecture

#### 1. Extend Tab Type System

```typescript
// MainContentTabs.tsx
interface Tab {
  id: string;
  label: string;
  type: 'chat' | 'diff' | 'file';  // ← Add 'diff' and 'file'
  closeable?: boolean;

  // Metadata for different tab types
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

#### 2. New Component: DiffViewer.tsx

```typescript
// src/features/workspace/ui/DiffViewer.tsx
interface DiffViewerProps {
  filePath: string;
  diff: string;
  additions: number;
  deletions: number;
}

/**
 * Inline Diff Viewer - Renders in tab content area
 *
 * Design:
 * - Clean header with file path + stats
 * - Syntax-highlighted unified diff
 * - Smooth scrolling with ScrollArea
 * - Copy diff button (top-right)
 */
export function DiffViewer({ filePath, diff, additions, deletions }: DiffViewerProps) {
  // Implementation below
}
```

**Visual Design:**
```
┌─────────────────────────────────────────────┐
│ 📄 src/features/workspace/ui/DiffViewer.tsx │
│    +42  -12                        [Copy]   │
├─────────────────────────────────────────────┤
│                                             │
│  1  | import { Button } from '@/ui'         │
│  2  | import { useState } from 'react'      │
│  3  |                                       │
│ +4  | export function DiffViewer() {        │ ← Green for additions
│ +5  |   const [tab, setTab] = useState()    │
│ -6  |   return <div>Old code</div>          │ ← Red for deletions
│  7  | }                                     │
│                                             │
└─────────────────────────────────────────────┘
```

#### 3. Update MainLayout.tsx - Tab Content Rendering

```typescript
// MainLayout.tsx (line ~220)
<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
  {/* Render content based on active tab type */}
  {(() => {
    const activeTab = mainTabs.find(t => t.id === activeMainTabId);

    if (activeTab?.type === 'chat') {
      return (
        <SessionPanel
          ref={workspaceChatPanelRef}
          sessionId={activeTab.data?.sessionId || selectedWorkspace.active_session_id}
          embedded={true}
        />
      );
    }

    if (activeTab?.type === 'diff') {
      return (
        <DiffViewer
          filePath={activeTab.data?.filePath || ''}
          diff={activeTab.data?.diff || ''}
          additions={activeTab.data?.additions || 0}
          deletions={activeTab.data?.deletions || 0}
        />
      );
    }

    // Future: 'file' type for full file viewer
    if (activeTab?.type === 'file') {
      return <FileViewer {...activeTab.data} />;
    }

    return null;
  })()}
</div>
```

#### 4. Update FileChangesPanel.tsx - Open as Tab

```typescript
// FileChangesPanel.tsx (line ~31)
async function handleFileClick(file: string) {
  if (!selectedWorkspace) return;

  currentFileRef.current = file;

  // ❌ OLD: openDiffModal(file, 'Loading...')

  // ✅ NEW: Open as tab in main content area
  onOpenDiffTab({
    file,
    diff: 'Loading...',
    additions: 0,
    deletions: 0
  });

  try {
    const { WorkspaceService } = await import('@/features/workspace/api/workspace.service');
    const data = await WorkspaceService.fetchFileDiff(selectedWorkspace.id, file);

    if (currentFileRef.current !== file) return;

    // Update tab with real diff data
    onUpdateDiffTab(file, {
      diff: data.diff || 'No diff available',
      additions: data.additions || 0,
      deletions: data.deletions || 0
    });
  } catch (error) {
    console.error('Failed to load diff:', error);
    if (currentFileRef.current !== file) return;
    onUpdateDiffTab(file, { diff: 'Error loading diff' });
  }
}
```

#### 5. MainLayout.tsx - Tab Management Functions

```typescript
// MainLayout.tsx (add these handlers)

/**
 * Open a diff as a new tab
 * - Reuses existing tab if same file is already open
 * - Positions new tab after current active tab
 */
function handleOpenDiffTab(fileData: { file: string; diff: string; additions: number; deletions: number }) {
  const fileName = fileData.file.split('/').pop() || fileData.file;
  const existingTabIndex = mainTabs.findIndex(
    t => t.type === 'diff' && t.data?.filePath === fileData.file
  );

  if (existingTabIndex !== -1) {
    // Tab exists - switch to it
    setActiveMainTabId(mainTabs[existingTabIndex].id);
    // Update diff content
    setMainTabs(tabs => tabs.map((t, i) =>
      i === existingTabIndex
        ? { ...t, data: { ...t.data, diff: fileData.diff, additions: fileData.additions, deletions: fileData.deletions } }
        : t
    ));
  } else {
    // Create new tab
    const newTab: Tab = {
      id: `diff-${Date.now()}`,
      label: fileName,
      type: 'diff',
      closeable: true,
      data: {
        filePath: fileData.file,
        diff: fileData.diff,
        additions: fileData.additions,
        deletions: fileData.deletions
      }
    };

    // Insert after current active tab
    const activeIndex = mainTabs.findIndex(t => t.id === activeMainTabId);
    const insertIndex = activeIndex + 1;
    const newTabs = [
      ...mainTabs.slice(0, insertIndex),
      newTab,
      ...mainTabs.slice(insertIndex)
    ];

    setMainTabs(newTabs);
    setActiveMainTabId(newTab.id);
  }
}

/**
 * Update an existing diff tab with new data (after async load)
 */
function handleUpdateDiffTab(filePath: string, updates: { diff?: string; additions?: number; deletions?: number }) {
  setMainTabs(tabs => tabs.map(t =>
    t.type === 'diff' && t.data?.filePath === filePath
      ? { ...t, data: { ...t.data, ...updates } }
      : t
  ));
}
```

---

## 🎨 Visual Design Specifications

### Tab Labels

**Diff Tab:**
```
┌──────────────────────┐
│ 📄 file.tsx    [×]   │  ← File icon + name (truncated) + close
└──────────────────────┘
```

**With Stats (optional, on hover):**
```
┌──────────────────────────────┐
│ 📄 file.tsx  +42 -12    [×]  │
└──────────────────────────────┘
```

### Diff Viewer Layout

```
┌─────────────────────────────────────────────────────────┐
│  Header (sticky)                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 📄 src/features/workspace/ui/DiffViewer.tsx      │  │
│  │ src/features/workspace/ui/                       │  │ ← Path context (muted)
│  │                                                   │  │
│  │ +42 additions  -12 deletions      [Copy Diff]   │  │ ← Stats + action
│  └──────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  Diff Content (scrollable)                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │  1  │ import { Button } from '@/components/ui'   │  │
│  │  2  │                                            │  │
│  │ +3  │ export function DiffViewer() {             │  │ ← Green bg
│  │ +4  │   const [tab, setTab] = useState()         │  │
│  │ -5  │   return <div>Old</div>                    │  │ ← Red bg
│  │  6  │ }                                          │  │
│  │     │                                            │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Color Palette (Tailwind v4 OKLCH)

```css
/* Diff additions (green) */
--color-diff-addition-bg: oklch(0.95 0.05 150);      /* Very light green bg */
--color-diff-addition-text: oklch(0.4 0.15 150);     /* Dark green text */
--color-diff-addition-border: oklch(0.7 0.1 150);    /* Medium green border */

/* Diff deletions (red) */
--color-diff-deletion-bg: oklch(0.95 0.05 30);       /* Very light red bg */
--color-diff-deletion-text: oklch(0.45 0.15 30);     /* Dark red text */
--color-diff-deletion-border: oklch(0.7 0.1 30);     /* Medium red border */

/* Diff context (neutral) */
--color-diff-context-bg: var(--background);          /* Default bg */
--color-diff-context-text: var(--muted-foreground);  /* Muted text */
```

### Typography

```typescript
// Line numbers: tabular-nums, monospace
className="font-mono text-xs text-muted-foreground/50 tabular-nums"

// Diff content: monospace, tight leading
className="font-mono text-xs leading-relaxed"

// File path: sans-serif, truncated
className="text-sm font-medium text-foreground truncate"
```

### Animations

```typescript
// Tab open animation (ease-out, 200ms)
className="animate-in fade-in-0 slide-in-from-bottom-2 duration-200"

// Active tab indicator (ease-out, 150ms)
className="transition-all duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]"
```

---

## 🚀 Implementation Phases

### Phase 1: Core Infrastructure (MVP)
- [ ] Extend `Tab` interface with `type: 'diff'` and `data` field
- [ ] Create `DiffViewer.tsx` component (basic unified diff display)
- [ ] Update `MainLayout.tsx` to render tabs conditionally
- [ ] Add `handleOpenDiffTab` and `handleUpdateDiffTab` functions
- [ ] Update `FileChangesPanel.tsx` to call new handlers (remove modal logic)
- [ ] Remove `DiffModal` imports from MainLayout

### Phase 2: Visual Polish
- [ ] Add diff syntax highlighting (+ green, - red, context gray)
- [ ] Style diff header with file stats (+42 -12)
- [ ] Add "Copy Diff" button
- [ ] Tab labels show file icon + truncated name
- [ ] Smooth tab open animation (200ms ease-out)

### Phase 3: Advanced Features
- [ ] Tab reuse: clicking same file switches to existing tab
- [ ] Tab positioning: insert after current active tab
- [ ] Keyboard shortcuts: `Cmd+W` close tab, `Cmd+Shift+[/]` switch tabs
- [ ] Diff search/filter (search within diff content)
- [ ] Split view: side-by-side diff mode

### Phase 4: Future Extensions
- [ ] Full file viewer (`type: 'file'`) for browsing entire files
- [ ] Image diffs (for PNG/JPG changes)
- [ ] Rich diff for JSON/YAML (structured comparison)
- [ ] Inline comments on diffs (collaboration)

---

## 🎯 Success Metrics

### UX Goals
- **Reduced Friction:** No modal close/open cycles → 0ms context switching
- **Context Preservation:** Users can reference chat while reviewing diffs
- **Spatial Consistency:** All interactions in one visual plane (no Z-axis jumps)

### Performance
- **Tab Open:** < 200ms from click to render
- **Diff Load:** Async, non-blocking (shows "Loading..." state)
- **Smooth Animations:** 60fps transitions (hardware-accelerated transforms)

### User Experience
- **Intuitive:** Users naturally discover tab-based navigation (familiar pattern)
- **Productive:** Multi-task: chat + diff + files in right panel
- **Delightful:** Smooth, responsive, minimal design

---

## 🧠 Technical Considerations

### State Management
- **Local State:** Tab data stored in `MainLayout` component state
- **Async Updates:** Diff loading updates tab data in-place (no re-mount)
- **Cleanup:** Remove Zustand `diffModal` state (no longer needed)

### Performance Optimizations
- **Virtualization:** For very large diffs (>1000 lines), use react-window
- **Syntax Highlighting:** Use lightweight parser (no heavy Prism.js)
- **Memoization:** Memo DiffViewer to prevent re-renders on tab switch

### Edge Cases
- **Multiple Files:** Users can open 10+ diff tabs → horizontal scroll in tab bar
- **Tab Overflow:** Show "..." menu for hidden tabs (future)
- **Stale Data:** If file changes again, show "Reload Diff" banner

---

## 📐 Design Inspiration

### Linear
- **Tab Bar:** Clean, minimal tabs with subtle hover states
- **Typography:** San Francisco Pro / SF Mono for consistency
- **Spacing:** Generous padding (16px), tight line-height for density

### Stripe
- **Color Usage:** Purposeful color (green/red only for +/-), neutral base
- **Microinteractions:** Smooth tab switch (ease-out), active indicator
- **Information Density:** Show stats (+42 -12) without clutter

### Airbnb
- **Whitespace:** Breathing room around content blocks
- **Hierarchy:** Clear visual hierarchy (header > content > actions)
- **Accessibility:** ARIA labels, keyboard navigation

### Jony Ive Philosophy
- **Intentionality:** Every element has a purpose (no decoration)
- **Simplicity:** Remove modals → one unified interaction model
- **Physicality:** Tabs feel tactile (smooth slide, clear affordance)

---

## 🎬 User Flow Example

**Before (Modal):**
```
1. User clicks "src/App.tsx" in FileChangesPanel
2. Modal pops up (covering entire screen) ❌
3. User reads diff
4. User closes modal
5. User lost context of chat
6. User clicks another file → modal again ❌
```

**After (Inline Tabs):**
```
1. User clicks "src/App.tsx" in FileChangesPanel
2. New tab opens: [Chat #1] [App.tsx] ✅
3. User reads diff
4. User switches to Chat #1 tab (instant) ✅
5. User references chat message
6. User clicks "styles.css" → new tab: [Chat #1] [App.tsx] [styles.css] ✅
7. User compares diffs by switching tabs ✅
```

**Benefit:** Fluid multi-tasking without context loss.

---

## 🔮 Future Vision

### Tab Types Ecosystem
```typescript
type TabType =
  | 'chat'      // Claude Code chat session
  | 'diff'      // Git diff viewer
  | 'file'      // Full file viewer (syntax highlighted)
  | 'browser'   // Embedded browser (future)
  | 'terminal'  // Inline terminal (future)
  | 'docs'      // Markdown docs viewer
```

**Ultimate Goal:** Unified workspace where everything lives in tabs
- No modals, no popups, no overlays
- Pure spatial navigation (left/right = switch context)
- Jony Ive's "functional minimalism" embodied

---

## 🛠️ Implementation Notes

### Remove After Implementation
- `DiffModal.tsx` (delete file)
- `uiStore.ts` → Remove `diffModal`, `openDiffModal`, `closeDiffModal`
- `MainLayout.tsx` → Remove `<DiffModal />` component

### Add to Git
- `src/features/workspace/ui/DiffViewer.tsx` (new file)
- `src/features/workspace/ui/MainContentTabs.tsx` (modified - Tab interface)
- `src/app/layouts/MainLayout.tsx` (modified - tab rendering logic)
- `src/features/workspace/ui/FileChangesPanel.tsx` (modified - click handler)

---

**End of Exploration Document**

This feature transforms the IDE from a **modal-heavy popup experience** into a **fluid, tab-based spatial interface**—the essence of great design: **less is more**.
