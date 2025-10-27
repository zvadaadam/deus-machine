# Complete Layout Hierarchy - Scroll Investigation

## Full DOM Tree with Styling

```
1. MainLayout (Component)
   └─ SidebarInset (className: "min-w-0")

      2. Grid Container
         style: {
           display: 'grid',
           gridTemplateColumns: 'minmax(500px, 1fr) 400px',
           height: '100%'
         }
         className: "flex-1 min-w-0 rounded-lg bg-background/70 ..."

         3. Main Content Column
            className: "flex flex-col h-full overflow-hidden border-r border-border/40"

            4. WorkspaceHeader
               className: "border-b border-border/60 bg-background/50 backdrop-blur-sm px-4 py-3 elevation-1 flex-shrink-0"
               ↑ FIXED HEIGHT (auto)

            5. MainContentTabBar
               className: "flex items-center border-b border-border/60 bg-background/80 backdrop-blur-sm flex-shrink-0"
               ↑ FIXED HEIGHT (auto)

            6. Content Wrapper
               className: "flex-1 min-h-0 overflow-hidden"
               ↑ SHOULD TAKE REMAINING HEIGHT

               7. SessionPanel (embedded=true)

                  8. SessionProvider

                     9. Container Div
                        className: "flex flex-col flex-1 min-h-0 min-w-0 relative"
                        ↑ ⚠️ PROBLEM: Has flex-1 but parent (#6) is NOT a flex container!

                        10. Chat Component
                            className: "relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth motion-reduce:scroll-auto min-h-0 px-6 pt-6"
                            ↑ SHOULD SCROLL HERE

                            11. Messages Container
                                className: "flex flex-col pb-32 min-h-0 min-w-0"

                                [Messages...]

                        12. Scroll Button
                            (positioned)

                        13. MessageInput
                            className: "..." (sticky at bottom)
                            ↑ SHOULD BE AT BOTTOM
```

## Issues Identified

### ❌ Issue #1: Parent Not Flex Container
**Line 176 in MainLayout**:
```tsx
<div className="flex-1 min-h-0 overflow-hidden">
  <SessionPanel /> <!-- Has flex-1 inside but parent is NOT flex -->
</div>
```

**Problem**: SessionPanel's inner div (line 168) has `flex flex-col flex-1`, but its parent wrapper (line 176) doesn't have `display: flex`. This breaks the height calculation.

**Fix**: Add `flex flex-col` to the Content Wrapper.

### ❌ Issue #2: Height Chain Broken
The height flows like this:
- Grid: `height: 100%` ✅
- Main Column: `h-full` ✅
- WorkspaceHeader: `flex-shrink-0` ✅
- TabBar: `flex-shrink-0` ✅
- Content Wrapper: `flex-1` ✅ BUT missing `flex flex-col`
- SessionPanel: `flex-1` ❌ (parent not flex)
- Chat: `flex-1 overflow-y-auto` ❌ (grandparent broke chain)

## Solution

Change line 176 in MainLayout from:
```tsx
<div className="flex-1 min-h-0 overflow-hidden">
```

To:
```tsx
<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
```

This ensures SessionPanel's flex-1 works correctly.
