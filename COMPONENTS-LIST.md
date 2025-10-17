# shadcn Components Installation List

## ✅ Foundation Complete
- [x] tailwind.config.js created
- [x] postcss.config.js created
- [x] components.json created
- [x] src/lib/utils.ts created (cn helper)
- [x] clsx and tailwind-merge installed

---

## 📦 Components to Install

### Priority 1: Core UI (INSTALL FIRST)
```bash
npx shadcn@latest add button badge skeleton card
```

- **button** - Replace custom Button.tsx
- **badge** - Replace custom Badge.tsx
- **skeleton** - Replace custom Skeleton.tsx
- **card** - For content sections in Dashboard

### Priority 2: Sidebar (CRITICAL!)
```bash
npx shadcn@latest add sidebar
```

- **sidebar** - For Dashboard left sidebar navigation

### Priority 3: Forms & Inputs
```bash
npx shadcn@latest add input textarea select label
```

- **input** - Text inputs in modals/forms
- **textarea** - Multi-line inputs (system prompt editor)
- **select** - Dropdowns (repo selection)
- **label** - Form labels

### Priority 4: Modals & Overlays
```bash
npx shadcn@latest add dialog
```

- **dialog** - Replace all modals (NewWorkspace, Diff, SystemPrompt)

### Priority 5: Layout & Navigation
```bash
npx shadcn@latest add scroll-area separator tabs
```

- **scroll-area** - Scrollable regions (sidebar, panels)
- **separator** - Visual dividers
- **tabs** - Could be useful for terminal/output switching

### Priority 6: Additional Components (Optional but useful)
```bash
npx shadcn@latest add dropdown-menu tooltip popover
```

- **dropdown-menu** - Context menus, actions
- **tooltip** - Helpful hints
- **popover** - Additional info display

---

## 🎯 Installation Order

1. Foundation (DONE ✅)
2. Core UI components
3. Sidebar component
4. Forms & inputs
5. Dialog/modals
6. Layout components
7. Additional components

---

## 📝 Usage Notes

After installing each component, it will be placed in:
- `src/components/ui/[component-name].tsx`

Import pattern:
```tsx
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar"
```

---

Last Updated: 2025-10-17
