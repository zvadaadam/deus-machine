# Shadcn/UI Migration - Progress Tracker

**Start Date:** 2025-10-17
**Status:** 🟡 In Progress

---

## Phase 1: Settings Page Refactor (HIGH PRIORITY)
**Status:** ✅ COMPLETE
**Estimated Time:** 2-3 hours
**Actual Time:** ~1.5 hours

### Tasks:
- [x] Install shadcn Checkbox component
- [x] Replace navigation buttons with shadcn Button (lines 105-113)
- [x] Replace back button with shadcn Button + ArrowLeft icon (lines 570-588)
- [x] Replace all checkboxes with shadcn Checkbox + Label
  - [x] General: notifications_enabled ✅
  - [x] General: sound_effects_enabled ✅
  - [x] Memory: conversation memory ✅
  - [x] Experimental: right_panel_visible ✅
  - [x] Experimental: using_split_view ✅
- [x] Replace all `<select>` with shadcn Select
  - [x] General: sound_type ✅
  - [x] General: diff_view_mode ✅
  - [x] Terminal: default_open_in ✅
  - [x] Memory: memory retention ✅
  - [x] Provider: claude_provider ✅
  - [x] Provider: claude_model ✅
- [x] Replace all text inputs with shadcn Input
  - [x] Account: user_name ✅
  - [x] Account: user_email ✅
  - [x] Account: user_github_username ✅
  - [x] Account: anthropic_api_key ✅
  - [x] Terminal: terminal_font_size ✅
  - [x] Provider: custom endpoint ✅
- [x] Remove inline styles (lines 570-588) ✅
- [x] Replace custom `.btn-secondary` with shadcn Button variant (line 414) ✅
- [x] Build test passed ✅

### Progress Notes:
**Completed successfully!**
- All navigation buttons now use shadcn Button with proper variants
- All checkboxes replaced with shadcn Checkbox + Label
- All selects replaced with shadcn Select
- All inputs replaced with shadcn Input
- Removed all inline styles
- Added proper Tailwind spacing classes (space-y-6, space-y-4, space-y-2)
- Build completes with zero errors
- Settings page now 100% shadcn compliant

---

## Phase 2: WorkspaceDetail Buttons
**Status:** 🔴 Not Started
**Estimated Time:** 1 hour

### Tasks:
- [ ] Import X, ArrowLeft, ChevronDown from lucide-react
- [ ] Replace close button (line 164)
  - Current: `<button onClick={onClose} className="close-btn">✕</button>`
  - Target: `<Button variant="ghost" size="icon"><X className="h-4 w-4" /></Button>`
- [ ] Replace back button (line 181)
  - Current: `<button onClick={() => setSelectedFile(null)} className="back-btn">← Back to Timeline</button>`
  - Target: `<Button variant="ghost"><ArrowLeft className="h-4 w-4" /> Back to Timeline</Button>`
- [ ] Replace scroll-to-bottom buttons (lines 138-145, 199-206)
  - Current: `<button className="scroll-to-bottom-btn">↓</button>`
  - Target: `<Button variant="secondary" size="icon" className="fixed bottom-24 right-6 rounded-full shadow-lg"><ChevronDown className="h-4 w-4" /></Button>`
- [ ] Remove custom CSS classes from WorkspaceDetail.css
  - `.close-btn`
  - `.back-btn`
  - `.scroll-to-bottom-btn`

### Progress Notes:
- Not started yet

---

## Phase 3: Dashboard Cards & Panels
**Status:** 🔴 Not Started
**Estimated Time:** 1-2 hours

### Tasks:
- [ ] Check if shadcn Card component is installed, install if needed
- [ ] Replace Overview section (lines 540-551) with Card
  - [ ] Import Card, CardHeader, CardTitle, CardContent from @/components/ui/card
  - [ ] Replace `.content-section` div with `<Card>`
  - [ ] Replace `.section-title` h3 with `<CardTitle>`
  - [ ] Replace `.section-content` with `<CardContent>`
  - [ ] Add Separator between stats items
- [ ] Refactor Dev Servers section (lines 562-596)
  - [ ] Replace custom `.right-panel-files` with proper container
  - [ ] Replace `.right-panel-header` with Card header
  - [ ] Remove inline styles (lines 576-591)
  - [ ] Replace hardcoded colors: `#9ca3af` → `text-muted-foreground`, `#10b981` → `text-success`
- [ ] Refactor File Changes panel (lines 598-635)
  - [ ] Replace `.file-change-item` with shadcn Button variant="ghost"
  - [ ] Replace `.file-name` with proper text classes
  - [ ] Replace `.file-stats` with Badge components
  - [ ] Replace `.stat-additions` with Badge variant="success"
  - [ ] Replace `.stat-deletions` with Badge variant="destructive"

### Progress Notes:
- Not started yet

---

## Phase 4: Design Consistency Pass
**Status:** 🔴 Not Started
**Estimated Time:** 1 hour

### Tasks:
- [ ] Replace all hardcoded colors
  - [ ] Find all instances of `#9ca3af` → replace with `text-muted-foreground`
  - [ ] Find all instances of `#10b981` → replace with `text-success` or `bg-success-500`
  - [ ] Find all instances of `#f3f4f6` → replace with `bg-muted`
  - [ ] Search for hex colors in .css files and replace
- [ ] Standardize padding
  - [ ] Audit all components for padding consistency
  - [ ] Set default to `p-4` (16px) per CLAUDE.md guidelines
  - [ ] Update any inconsistent padding
- [ ] Standardize animations
  - [ ] Find all transition/animation declarations
  - [ ] Ensure all use 200-300ms duration
  - [ ] Ensure all use `ease-out` timing function per CLAUDE.md
  - [ ] Remove any `linear` or `ease-in` timings
- [ ] Clean up unused CSS
  - [ ] Remove unused classes from Settings.css
  - [ ] Remove unused classes from WorkspaceDetail.css
  - [ ] Remove unused classes from Dashboard-related CSS
  - [ ] Check App.css for unused styles
- [ ] Final audit
  - [ ] Test all pages in browser
  - [ ] Verify all components use shadcn
  - [ ] Verify no inline styles remain
  - [ ] Verify consistent spacing/padding
  - [ ] Verify smooth animations

### Progress Notes:
- Not started yet

---

## Overall Progress

| Phase | Status | Time Est. | Time Actual | Progress |
|-------|--------|-----------|-------------|----------|
| Phase 1: Settings | 🔴 Not Started | 2-3h | - | 0% |
| Phase 2: WorkspaceDetail | 🔴 Not Started | 1h | - | 0% |
| Phase 3: Dashboard | 🔴 Not Started | 1-2h | - | 0% |
| Phase 4: Consistency | 🔴 Not Started | 1h | - | 0% |
| **TOTAL** | 🔴 **0% Complete** | **5-7h** | **-** | **0%** |

---

## Blockers & Notes

None yet.

---

## Testing Checklist (Run after each phase)

- [ ] npm run dev - no build errors
- [ ] Navigate to Settings page - all components render correctly
- [ ] Test all form inputs - checkboxes, selects, text inputs work
- [ ] Test all buttons - hover states, click handlers work
- [ ] Test modals - all modals open/close correctly
- [ ] Test workspace selection - workspace detail view works
- [ ] Visual inspection - consistent design across all pages
- [ ] Accessibility check - keyboard navigation works

---

## Completion Criteria

✅ All native HTML inputs replaced with shadcn components
✅ All custom buttons replaced with shadcn Button
✅ No hardcoded colors remain
✅ Consistent 16px padding everywhere
✅ All animations 200-300ms ease-out
✅ 100% shadcn/ui component coverage
✅ Zero inline styles
✅ Clean, maintainable CSS files
