# Sidebar Typography Hierarchy

## ✅ Applied Typography System

The sidebar now uses our semantic typography scale from `tailwind.config.js` for consistent, maintainable design.

---

## 📐 Visual Hierarchy

```
┌─────────────────────────────────┐
│  👤 Developer                   │  ← text-body (14px, medium)
│      ↑ Profile - Most prominent │
├─────────────────────────────────┤
│  ⌄ dev-browser                3 │  ← text-body-sm (13px, semibold)
│      ↑ Repo Group - Section    │     text-caption (12px)
│                                 │
│    🌿 main                +5 -2 │  ← text-body-sm (13px, medium)
│       stockholm-v4 • 2h ago    │     text-caption (12px, mono)
│       ↑ Workspace Item          │
│                                 │
│    🌿 feature-branch            │
│       zurich-v2 • 5m ago        │
│                                 │
├─────────────────────────────────┤
│  📁 New Workspace               │  ← text-body-sm (13px)
│      ↑ Footer Action            │
└─────────────────────────────────┘
```

---

## 🎨 Typography Mapping

### 1. Profile Section
**Location**: `app-sidebar.tsx:86`
```tsx
<p className="text-body font-medium">Developer</p>
```
- **Size**: 14px
- **Weight**: Medium (500)
- **Purpose**: Most prominent element, user identity

**Avatar Initials**: `app-sidebar.tsx:82, 91`
```tsx
<AvatarFallback className="text-caption">DE</AvatarFallback>
```
- **Size**: 12px
- **Purpose**: Compact initials

---

### 2. Repository Groups
**Location**: `RepoGroup.tsx:49`
```tsx
<span className="text-body-sm font-semibold">dev-browser</span>
<span className="text-caption text-muted-foreground">3</span>
```
- **Repo Name**: 13px, semibold → Section header prominence
- **Count**: 12px, muted → Supporting information

---

### 3. Workspace Items
**Location**: `WorkspaceItem.tsx:35`
```tsx
<span className="text-body-sm font-medium">main</span>
```
- **Branch Name**: 13px, medium
- **Purpose**: Primary workspace identifier

**Diff Stats**: `WorkspaceItem.tsx:39`
```tsx
<div className="text-caption font-mono">+5 -2</div>
```
- **Size**: 12px, monospace
- **Purpose**: Compact, scannable metrics

**Metadata**: `WorkspaceItem.tsx:53`
```tsx
<div className="text-caption text-muted-foreground">
  <span>stockholm-v4</span> • <span>2h ago</span>
</div>
```
- **Size**: 12px, muted
- **Purpose**: Supporting context

---

### 4. Footer Actions
**Location**: `app-sidebar.tsx:129`
```tsx
<span className="text-body-sm">New Workspace</span>
```
- **Size**: 13px
- **Purpose**: Action button text

---

## 🎯 Design Rationale

### Size Hierarchy (Biggest → Smallest)
1. **14px** (text-body) - Profile name → User identity
2. **13px** (text-body-sm) - Repo groups, workspaces, actions → Content
3. **12px** (text-caption) - Metadata, stats, counts → Supporting info

### Weight Hierarchy (Boldest → Lightest)
1. **Semibold (600)** - Repo group names → Section headers
2. **Medium (500)** - Profile, workspace names → Emphasis
3. **Normal (400)** - Metadata, stats → De-emphasized

### This Creates:
- ✅ **Clear visual flow** - Eye naturally moves top to bottom
- ✅ **Scannable hierarchy** - Important info stands out
- ✅ **Consistent spacing** - Semantic sizes, not arbitrary
- ✅ **Professional feel** - Like Linear, Arc, Vercel

---

## 🔧 Benefits Over Previous Approach

### Before (Arbitrary)
```tsx
<span className="text-sm">...</span>     // What size is sm? 14px? 12px?
<span className="text-xs">...</span>     // Inconsistent, no meaning
```

### After (Semantic)
```tsx
<span className="text-body-sm">...</span>     // 13px, for body content
<span className="text-caption">...</span>    // 12px, for captions
```
- ✅ **Autocomplete** - Type `text-` and see all options
- ✅ **Semantic** - Name tells you the purpose
- ✅ **Consistent** - Defined once in `tailwind.config.js`
- ✅ **Maintainable** - Change config to update everywhere

---

## 📱 Responsive Behavior

All typography scales properly when sidebar collapses:
- Profile → Avatar only (initials remain readable at 12px)
- Repo groups → Icons only
- Workspaces → Icons only
- Footer → Icon only

Typography maintains hierarchy even in collapsed state.

---

## 🚀 Usage Guidelines

When adding new sidebar elements:

**For section headers:**
```tsx
className="text-body-sm font-semibold"  // Like repo groups
```

**For content items:**
```tsx
className="text-body-sm font-medium"    // Like workspace names
```

**For metadata/labels:**
```tsx
className="text-caption text-muted-foreground"  // Like timestamps
```

**For prominent titles:**
```tsx
className="text-body font-medium"       // Like profile name
```

---

**This is production-ready, scalable typography!** ✨
