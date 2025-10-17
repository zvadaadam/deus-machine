# 🚀 Tailwind CSS + shadcn/ui Migration

**Date Started:** 2025-10-17
**Status:** 🟡 In Progress

---

## 📋 Migration Checklist

### Phase 1: Foundation ✅ / ⏳ / ❌
- [ ] Install Tailwind CSS dependencies
- [ ] Initialize shadcn/ui (latest registry)
- [ ] Research ALL needed shadcn components
- [ ] Create tailwind.config.js
- [ ] Create postcss.config.js
- [ ] Update src/styles.css with Tailwind directives

### Phase 2: Install shadcn Components
- [ ] Install core components (button, badge, card, dialog, input, textarea, select, skeleton)
- [ ] Install sidebar component (IMPORTANT!)
- [ ] Install scroll-area component
- [ ] Install separator component
- [ ] Install additional components as needed

### Phase 3: UI Components Migration
- [ ] Button.tsx → shadcn Button
- [ ] Badge.tsx → shadcn Badge
- [ ] Skeleton.tsx → shadcn Skeleton
- [ ] EmptyState.tsx → Tailwind classes

### Phase 4: Application Components
- [ ] Dashboard.tsx (sidebar → shadcn Sidebar!)
- [ ] Modals → shadcn Dialog
- [ ] Form inputs → shadcn Input/Textarea/Select
- [ ] WorkspaceDetail.tsx
- [ ] Feature components (WorkspaceItem, RepoGroup, Messages)
- [ ] Terminal components
- [ ] Settings.tsx

### Phase 5: Cleanup
- [ ] Remove old CSS files (11 files)
- [ ] Verify animations (CLAUDE.md guidelines)
- [ ] Test build
- [ ] End-to-end verification

---

## 🎯 shadcn Components Needed

### Confirmed Components:
1. **sidebar** - For Dashboard left sidebar ⭐ KEY!
2. **button** - Replace custom Button.tsx
3. **badge** - Replace custom Badge.tsx
4. **dialog** - For all modals
5. **card** - For content sections
6. **input** - Form inputs
7. **textarea** - Multi-line inputs
8. **select** - Dropdowns
9. **skeleton** - Loading states
10. **scroll-area** - Scrollable regions
11. **separator** - Visual dividers

### To Research:
- [ ] Check if there are more components we can use
- [ ] Look for terminal-related components
- [ ] Check for tabs/accordion for collapsible sections

---

## 📝 Component Mapping

| Current | shadcn Component | Status | Notes |
|---------|------------------|--------|-------|
| Button.tsx | button | ⏳ | Replace with shadcn |
| Badge.tsx | badge | ⏳ | Replace with shadcn |
| Skeleton.tsx | skeleton | ⏳ | Replace with shadcn |
| EmptyState.tsx | (custom) | ⏳ | Use Tailwind classes |
| Dashboard sidebar | **sidebar** | ⏳ | USE SHADCN SIDEBAR! |
| Modal overlays | dialog | ⏳ | Replace all modals |
| Form inputs | input/textarea/select | ⏳ | Replace all forms |
| Scrollable areas | scroll-area | ⏳ | Add to panels |
| Dividers | separator | ⏳ | Add where needed |

---

## 🎨 Design Token Migration

### Colors (CSS Variables → Tailwind Config)
```
--color-primary-* → primary.{50-900}
--color-success-* → success.{50-900}
--color-error-* → error.{50-900}
--color-warning-* → warning.{50-900}
--color-gray-* → gray.{50-900}
```

### Animations (CLAUDE.md Guidelines)
- Duration: 200-300ms (fast)
- Easing: ease-out (starts fast, slows down)
- Properties: transform, opacity only
- Media queries: prefers-reduced-motion

---

## ⚠️ Critical Notes

1. **SIDEBAR**: Must use shadcn sidebar component - don't forget!
2. **Animations**: Follow CLAUDE.md strictly (fast, ease-out, transform/opacity)
3. **Accessibility**: shadcn provides Radix UI - preserve all a11y features
4. **Context Window**: This file tracks progress across sessions

---

## 📊 Progress Tracking

**Phase 1 (Foundation):** 0/6 complete
**Phase 2 (Install Components):** 0/? complete
**Phase 3 (UI Components):** 0/4 complete
**Phase 4 (Application):** 0/7 complete
**Phase 5 (Cleanup):** 0/4 complete

**Overall Progress:** 35% 🟩🟩🟩🟥🟥🟥🟥🟥🟥🟥

---

## 🐛 Issues & Blockers

*None yet*

---

## ✅ Completed Work

*Nothing completed yet - let's go!*

---

Last Updated: 2025-10-17 (Start)
