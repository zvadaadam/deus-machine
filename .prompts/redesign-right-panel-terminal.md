# Task: Redesign Right Panel - Collapsible Terminal + File Browser

## Current Architecture Analysis

### Current State (MainLayout.tsx lines 268-310)
```
Right Panel (400px fixed width)
├── Tabs (Changes | Terminal)
    ├── TabsContent: FileChangesPanel (shows modified files)
    └── TabsContent: TerminalPanel (shows terminal)
```

**State Management:**
- `rightPanelTab: 'changes' | 'terminal'` (line 359)
- Tabs are mutually exclusive (only one visible at a time)

### Components Involved
1. **FileChangesPanel** (`src/features/workspace/ui/FileChangesPanel.tsx`)
   - Shows: Dev servers + file changes (files with +/- stats)
   - Props: `selectedWorkspace`
   - Height: `flex-1` (takes full available height)

2. **TerminalPanel** (`src/features/terminal/ui/TerminalPanel.tsx`)
   - Shows: Terminal tabs with xterm.js instances
   - Props: `workspacePath`, `workspaceName`
   - Height: `flex-1` (takes full available height)
   - Features: Multiple terminal tabs, Run button, browser preview

## New Architecture Goals

### Desired Layout
```
Right Panel (400px fixed width)
├── Tabs (Files | Changes)  ← New tab structure
│   ├── Files Tab → FileBrowserPanel (NEW - shows all files in directory)
│   └── Changes Tab → FileChangesPanel (existing - shows modified files)
├── Divider (draggable? optional)
└── CollapsibleTerminal (NEW wrapper)
    ├── Collapse/Expand Button (when expanded)
    ├── TerminalPanel (existing component)
    └── Console Bar (when collapsed) - click to expand
```

### Key Features
1. **Files Tab**: Browse ALL files in workspace directory (not just changed files)
2. **Changes Tab**: Current FileChangesPanel (modified files only)
3. **Terminal Always Present**: At bottom, can collapse/expand
4. **Collapsed State**: Shows "Console" bar at bottom, click to expand
5. **Expanded State**: Shows full terminal with collapse button

## Implementation Plan

### Phase 1: Create New Components

#### 1.1 Create `CollapsibleTerminalPanel` Component
**Location:** `src/features/terminal/ui/CollapsibleTerminalPanel.tsx`

**Purpose:** Wrapper around TerminalPanel that adds collapse/expand functionality

**State:**
```typescript
interface CollapsibleTerminalPanelProps {
  workspacePath: string;
  workspaceName: string;
  defaultHeight?: number; // Default expanded height in px
}

const [isExpanded, setIsExpanded] = useState(true);
const [height, setHeight] = useState(defaultHeight || 250);
```

**UI Structure:**
```tsx
{isExpanded ? (
  <div className="flex flex-col" style={{ height: `${height}px` }}>
    {/* Header with collapse button */}
    <div className="flex items-center justify-between px-3 py-2 border-t border-border/60">
      <span className="text-xs text-muted-foreground">Terminal</span>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsExpanded(false)}
        title="Collapse terminal"
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
    </div>

    {/* Terminal content */}
    <div className="flex-1 overflow-hidden">
      <TerminalPanel
        workspacePath={workspacePath}
        workspaceName={workspaceName}
      />
    </div>
  </div>
) : (
  // Collapsed state - just a bar at bottom
  <div
    className="h-8 border-t border-border/60 bg-muted/30 flex items-center justify-between px-3 cursor-pointer hover:bg-muted/50 transition-colors"
    onClick={() => setIsExpanded(true)}
  >
    <span className="text-xs text-muted-foreground">Console</span>
    <ChevronUp className="h-3 w-3 text-muted-foreground" />
  </div>
)}
```

**Styling Considerations:**
- Smooth height transitions: `transition-[height] duration-300 ease-out`
- Match existing terminal styling from TerminalPanel
- Use subtle borders and backgrounds
- Small icons/text to save space

#### 1.2 Create `FileBrowserPanel` Component
**Location:** `src/features/workspace/ui/FileBrowserPanel.tsx`

**Purpose:** Browse ALL files in workspace directory

**Requirements:**
- Fetch file tree from backend (need to check if API exists)
- Display as tree view with folders and files
- Click to open file (TBD: what happens on click? View file? Open in editor?)
- Match styling of FileChangesPanel (small fonts, subtle colors)

**Temporary Implementation:**
If backend API doesn't exist yet, show placeholder:
```tsx
<EmptyState
  icon={<FileCode />}
  description="File browser coming soon"
/>
```

**Future API Needed:**
- `GET /api/v1/workspaces/:id/files` → Returns file tree structure
- Should respect .gitignore

### Phase 2: Modify MainLayout.tsx

#### 2.1 Update State (around line 359)
```typescript
// REMOVE: rightPanelTab state (no longer needed)
// const [rightPanelTab, setRightPanelTab] = useState<'changes' | 'terminal'>('changes');

// ADD: New tab state for Files vs Changes
const [rightPanelViewTab, setRightPanelViewTab] = useState<'files' | 'changes'>('changes');

// Terminal collapse state is managed by CollapsibleTerminalPanel internally
```

#### 2.2 Update Right Panel JSX (lines 268-310)

**Replace:**
```tsx
<div className="flex flex-col h-full overflow-hidden">
  <Tabs value={rightPanelTab} onValueChange={...}>
    {/* TabsList with Changes | Terminal */}
    {/* TabsContent for Changes */}
    {/* TabsContent for Terminal */}
  </Tabs>
</div>
```

**With:**
```tsx
<div className="flex flex-col h-full overflow-hidden">
  {/* Top Section: Files/Changes Tabs */}
  <Tabs value={rightPanelViewTab} onValueChange={(v) => setRightPanelViewTab(v as any)} className="flex-1 flex flex-col overflow-hidden min-h-0">
    <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm flex-shrink-0">
      <TabsList className="h-11 w-full justify-start rounded-none bg-transparent p-0 px-2 gap-1">
        <TabsTrigger value="files">
          <FolderOpen className="h-4 w-4 mr-2" />
          <span className="text-body-sm font-medium">Files</span>
        </TabsTrigger>
        <TabsTrigger value="changes">
          <FileText className="h-4 w-4 mr-2" />
          <span className="text-body-sm font-medium">Changes</span>
        </TabsTrigger>
      </TabsList>
    </div>

    {/* Files Tab */}
    <TabsContent value="files" className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden">
      <FileBrowserPanel selectedWorkspace={selectedWorkspace} />
    </TabsContent>

    {/* Changes Tab */}
    <TabsContent value="changes" className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden">
      <FileChangesPanel selectedWorkspace={selectedWorkspace} />
    </TabsContent>
  </Tabs>

  {/* Bottom Section: Collapsible Terminal */}
  <CollapsibleTerminalPanel
    workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
    workspaceName={selectedWorkspace.branch}
  />
</div>
```

#### 2.3 Update Imports
```typescript
// REMOVE Terminal icon import (no longer need Terminal tab)
// KEEP FileText for Changes tab
// ADD FolderOpen for Files tab

import {
  FileText,
  FolderOpen, // NEW
  // ... other imports
} from 'lucide-react';

// ADD new component imports
import { FileBrowserPanel } from '@/features/workspace';
import { CollapsibleTerminalPanel } from '@/features/terminal';
```

#### 2.4 Remove MainContent Props
In `MainContent` component (lines 60-80), remove:
- `rightPanelTab` prop
- `onRightPanelTabChange` prop

These are no longer passed from parent since terminal is always visible.

### Phase 3: Update Component Exports

#### 3.1 Terminal Feature Export
**File:** `src/features/terminal/index.ts`

Add:
```typescript
export { CollapsibleTerminalPanel } from './ui/CollapsibleTerminalPanel';
```

#### 3.2 Workspace Feature Export
**File:** `src/features/workspace/ui/index.ts`

Add:
```typescript
export { FileBrowserPanel } from './FileBrowserPanel';
```

### Phase 4: Styling Details

#### Height Distribution
```
Right Panel (100%)
├── Files/Changes Tabs + Content: flex-1 min-h-0 (grows, minimum 200px suggested)
└── CollapsibleTerminal:
    ├── Expanded: fixed height (250px default, maybe resizable later)
    └── Collapsed: fixed 32px bar
```

#### Key CSS Classes
- Use `min-h-0` to prevent flex children from overflowing
- Use `overflow-hidden` on containers
- Use `overflow-y-auto` on scrollable content
- Match existing styling from FileChangesPanel and TerminalPanel
- Subtle borders: `border-border/60`
- Muted backgrounds: `bg-muted/30`

#### Transitions
```typescript
// CollapsibleTerminalPanel
className={cn(
  "transition-[height] duration-300 ease-out",
  isExpanded ? "h-[250px]" : "h-8"
)}
```

### Phase 5: Future Enhancements (NOT in initial implementation)

1. **Draggable Divider**: Let user resize terminal height
2. **FileBrowserPanel Full Features**:
   - Tree view with expand/collapse folders
   - File icons based on extension
   - Click to view file content
   - Search/filter files
3. **Terminal State Persistence**: Remember collapsed/expanded state across sessions
4. **Keyboard Shortcuts**:
   - `Cmd+J` toggle terminal
   - `Cmd+Shift+E` focus Files tab

## Testing Checklist

- [ ] Files tab shows placeholder (FileBrowserPanel)
- [ ] Changes tab shows FileChangesPanel correctly
- [ ] Terminal expands/collapses smoothly
- [ ] Collapsed terminal shows "Console" bar at bottom
- [ ] Click on Console bar expands terminal
- [ ] Terminal collapse button works
- [ ] Terminal maintains functionality (tabs, run button, etc.)
- [ ] No layout overflow or scrolling issues
- [ ] Styling matches existing design system
- [ ] Works when browser panel is open (grid layout)

## Files to Create

1. `src/features/terminal/ui/CollapsibleTerminalPanel.tsx` (NEW)
2. `src/features/workspace/ui/FileBrowserPanel.tsx` (NEW)

## Files to Modify

1. `src/app/layouts/MainLayout.tsx`
   - Remove `rightPanelTab` state
   - Add `rightPanelViewTab` state
   - Replace Tabs structure (lines 268-310)
   - Update imports
   - Remove terminal-related props from MainContent

2. `src/features/terminal/index.ts`
   - Export CollapsibleTerminalPanel

3. `src/features/workspace/ui/index.ts`
   - Export FileBrowserPanel

## Design Philosophy

- **No over-engineering**: Start simple, add features later
- **Consistent styling**: Match existing panels (small fonts, subtle colors)
- **Smooth transitions**: Use ease-out, ~300ms duration
- **Accessibility**: Proper ARIA labels, keyboard navigation
- **Performance**: No unnecessary re-renders, efficient state management

## Notes

- Terminal functionality remains unchanged (existing TerminalPanel component)
- FileChangesPanel remains unchanged (already has good styling)
- Focus is on layout restructuring, not feature changes
- FileBrowserPanel starts as placeholder, implement fully later when backend API is ready
