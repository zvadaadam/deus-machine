# UI/UX Analysis & Issues Found

## Testing Summary
- **Date**: 2025-10-17
- **Method**: Browser automation with visual testing
- **Scope**: Dashboard, Workspace Detail, Message Flow

---

## 🚨 Critical Errors

### 1. Backend API Errors (404)
**Location**: `/api/workspaces/{id}/dev-servers`
**Error**: Server responds with 404, frontend expects JSON but gets HTML
```
Failed to load resource: the server responded with a status of 404 (Not Found)
Failed to load dev servers: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```
**Impact**: Dev servers feature completely broken
**Fix Required**: Backend endpoint missing or misconfigured

### 2. Socket Connection Errors
**Location**: `src/services/socket.ts:18`, `src/hooks/useSocket.ts:8`
**Error**: `Cannot read properties of undefined (reading 'invoke')`
```
[SOCKET] ❌ Connection failed: TypeError: Cannot read properties of undefined (reading 'invoke')
[useSocket] ❌ Socket connection failed
```
**Impact**: Real-time communication broken, Tauri invoke undefined
**Fix Required**: Socket service needs fallback for web mode (non-Tauri environment)

---

## 🎨 Design & UX Issues

### 3. Empty State Design - Poor Visual Hierarchy
**Location**: Dashboard (no workspace selected), Message area
**Current State**:
- Purple/lavender background with emoji and text
- Low contrast, poor readability
- Emoji too large, overwhelming the message
- Not following shadcn design patterns

**Issues**:
- Background color (#f3e8ff or similar) is too bright/saturated
- Text color has low contrast against background
- No clear visual hierarchy
- Doesn't match the rest of the UI design system

**Recommendation**: Use shadcn's Alert or Card component with proper design tokens

### 4. Workspace Header - Poor Visual Separation
**Location**: Workspace detail view header
**Current State**:
- Title "prague", status badges "✓ ready", "✓ idle"
- Action buttons: System Prompt, Compact, Create PR, Archive
- Repository info below

**Issues**:
- No clear visual separation between sections
- Buttons all same style, no primary/secondary distinction
- Status badges use text with checkmarks instead of proper Badge component
- Poor spacing and alignment
- Missing visual hierarchy

**Recommendation**:
- Use shadcn Badge for status indicators
- Differentiate primary actions (Create PR) from secondary actions
- Add proper spacing with Tailwind utilities
- Group related elements visually

### 5. File Changes Panel - Design Inconsistency
**Location**: Right sidebar panel
**Current State**:
- Lists changed files with +/- indicators
- Files are clickable to view diff

**Issues**:
- File items lack proper hover states
- +/- indicators styling inconsistent with design system
- No visual feedback for selected/active file
- Poor contrast between items
- Missing shadcn components (could use List items or Card variants)

**Recommendation**:
- Use shadcn's proper hover states with `@media (hover: hover)`
- Implement Badge component for +/- indicators
- Add clear selected state with background color
- Better spacing between items

### 6. Message Input Area - Basic Styling
**Location**: Workspace detail bottom
**Current State**:
- Textarea with placeholder
- Send button on right

**Issues**:
- Send button uses basic emoji "➤Send" instead of icon
- No clear visual indication when disabled
- Missing proper focus states
- Could benefit from shadcn Input/Textarea patterns

**Recommendation**:
- Use Lucide React icon instead of emoji
- Add proper disabled styling (opacity, cursor)
- Implement focus ring with design system colors
- Consider adding keyboard shortcut hint

### 7. Sidebar Workspace List - Cluttered
**Location**: Left sidebar
**Current State**:
- Nested structure with repositories and workspaces
- Shows branch name, session name, time, +/- stats

**Issues**:
- Too much information crammed in small space
- Text truncation not implemented properly
- Active state not visually distinctive enough
- Poor spacing between items
- Repository grouping could be cleaner

**Recommendation**:
- Implement text truncation with Tailwind `truncate`
- Stronger active state with border or background
- Better spacing with Tailwind spacing utilities
- Consider collapsible repository groups with shadcn Collapsible

### 8. Color Palette - Inconsistent Usage
**Current State**:
- Using multiple shades of purple/lavender
- Some colors don't match design system
- Inconsistent use of success/primary colors

**Issues**:
- Empty states use custom purple (#f3e8ff) not in design tokens
- Success color (green) used for assistant messages
- Primary color (blue) used for user messages
- No consistent semantic color system

**Recommendation**:
- Stick to HSL CSS variables from shadcn config
- Use semantic colors (primary, destructive, success) consistently
- Remove custom colors not in design system
- Update CLAUDE.md animation guidelines compliance

---

## 📊 Animation & Performance Issues

### 9. Animation Guidelines Not Fully Implemented
**CLAUDE.md Requirements**:
- 200-300ms duration
- `ease-out` for most animations
- Hardware acceleration for transforms/opacity
- `prefers-reduced-motion` support

**Current Issues**:
- Some transitions use default CSS `ease` instead of custom easings
- Not all animations disable in `prefers-reduced-motion`
- Missing `will-change` optimization hints
- Some animations over 300ms

**Files to Check**:
- All component transitions
- Sidebar collapse/expand
- Modal animations
- Empty state animations

---

## 🔧 Technical Debt

### 10. Missing Error Boundaries
**Impact**: Errors crash entire UI instead of showing error state
**Recommendation**: Add React Error Boundaries with shadcn Alert for errors

### 11. No Loading States
**Impact**: Users see blank screens while data loads
**Recommendation**: Use shadcn Skeleton components (already imported but not used everywhere)

### 12. Accessibility Issues
**Issues Found**:
- Some interactive elements missing ARIA labels
- Focus states not always visible
- Color contrast issues in empty states
- No keyboard navigation hints

---

## ✅ What's Working Well

1. **Sidebar Component**: Good use of shadcn Collapsible
2. **Overall Layout**: react-resizable-panels working well
3. **File Changes Loading**: Proper loading and caching logic
4. **Build**: No TypeScript errors, clean build

---

## 🎯 Priority Fixes

### High Priority (Breaks Functionality)
1. ✅ Fix backend 404 errors for dev-servers endpoint
2. ✅ Fix socket connection errors (add web fallback)

### Medium Priority (UX Issues)
3. ✅ Redesign empty states with shadcn components
4. ✅ Improve workspace header design and hierarchy
5. ✅ Enhance file changes panel styling

### Low Priority (Polish)
6. Add error boundaries
7. Implement loading states everywhere
8. Fix all animation timings per CLAUDE.md
9. Accessibility improvements

---

## 📝 Next Steps

1. Start with backend API fixes (404 errors)
2. Add socket service fallback for web mode
3. Redesign all empty states with shadcn Alert/Card
4. Improve workspace header with proper shadcn components
5. Polish file changes panel design
6. Update all animations to follow CLAUDE.md guidelines
