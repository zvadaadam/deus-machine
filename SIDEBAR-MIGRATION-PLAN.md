# Dashboard Sidebar Migration to shadcn Sidebar

**Task:** Migrate custom sidebar to shadcn Sidebar component
**Priority:** HIGH (Biggest remaining task)
**Estimated Time:** 1 hour

---

## Current Structure

```
Dashboard.tsx:
├── Panel (left sidebar)
│   ├── div.sidebar
│   │   ├── div.sidebar-header
│   │   │   ├── h1 "Conductor"
│   │   │   └── Settings button + status dot
│   │   ├── div.sidebar-controls
│   │   │   └── button "New Workspace"
│   │   └── div.sidebar-content
│   │       └── RepoGroup[] (map)
│   │           └── WorkspaceItem[] (map)
```

**RepoGroup Component:**
- Collapsible header with repo name
- List of workspace items
- Filter: only show "ready" workspaces

**WorkspaceItem Component:**
- Branch name
- Diff stats (+/-)
- Active state styling
- Click handler

---

## Target Structure (shadcn)

```tsx
<SidebarProvider>
  <Sidebar>
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <div>Conductor</div>
          <div>Settings + Status</div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <Button>+ New Workspace</Button>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* For each RepoGroup */}
      <SidebarGroup>
        <SidebarGroupLabel>
          <Collapsible>
            {repo_name}
          </Collapsible>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {/* For each WorkspaceItem */}
            <SidebarMenuItem>
              <SidebarMenuButton isActive={...}>
                <span>🌿</span>
                <div>
                  <div>{branch}</div>
                  <div>{diffStats}</div>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
</SidebarProvider>
```

---

## Migration Steps

### Step 1: Wrap Dashboard with SidebarProvider ✅
```tsx
import { SidebarProvider } from "@/components/ui/sidebar"

export function Dashboard() {
  return (
    <SidebarProvider>
      <PanelGroup>
        {/* existing code */}
      </PanelGroup>
    </SidebarProvider>
  )
}
```

### Step 2: Replace sidebar div with Sidebar component
Replace:
```tsx
<div className="panel-content sidebar">
  <div className="sidebar-header">...</div>
  <div className="sidebar-controls">...</div>
  <div className="sidebar-content">...</div>
</div>
```

With:
```tsx
<Sidebar>
  <SidebarHeader>...</SidebarHeader>
  <SidebarContent>
    <SidebarGroup>...</SidebarGroup>
  </SidebarContent>
</Sidebar>
```

### Step 3: Migrate RepoGroup to SidebarGroup with Collapsible
```tsx
<SidebarGroup>
  <Collapsible
    open={!isCollapsed}
    onOpenChange={onToggleCollapse}
  >
    <SidebarGroupLabel asChild>
      <CollapsibleTrigger>
        <ChevronDown />
        {repo_name}
      </CollapsibleTrigger>
    </SidebarGroupLabel>
    <CollapsibleContent>
      <SidebarGroupContent>
        <SidebarMenu>
          {/* Workspace items */}
        </SidebarMenu>
      </SidebarGroupContent>
    </CollapsibleContent>
  </Collapsible>
</SidebarGroup>
```

### Step 4: Migrate WorkspaceItem to SidebarMenuItem
```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    isActive={isActive}
    onClick={onClick}
  >
    <span>🌿</span>
    <div>
      <div>{branch}</div>
      <div className="diff-stats">
        <span className="additions">+{additions}</span>
        <span className="deletions">-{deletions}</span>
      </div>
    </div>
  </SidebarMenuButton>
</SidebarMenuItem>
```

### Step 5: Add Collapsible component if not already installed
```bash
npx shadcn@latest add collapsible
```

### Step 6: Test & Verify
- Sidebar renders correctly
- Collapse/expand works
- Workspace selection works
- Active state styling works
- Scrolling works
- Diff stats display correctly

---

## Key Differences

1. **No custom CSS needed** - shadcn Sidebar handles all styling
2. **Built-in accessibility** - ARIA attributes, keyboard navigation
3. **Responsive** - Mobile support out of the box
4. **Collapsible** - Use shadcn's Collapsible component
5. **Active states** - Use `isActive` prop on SidebarMenuButton

---

## Benefits

✅ No custom CSS to maintain
✅ Accessible by default
✅ Mobile-responsive
✅ Keyboard navigation
✅ Focus management
✅ Consistent with shadcn design system

---

Last Updated: 2025-10-17 16:50
