# Right workspace panel

Implemented in `apps/web`; the desktop is ready for visual review.

The current design is in `deus.pen`: overview `00c`, controls `22b`, and screens
`40d`–`40f`, starting at y=18,640. Each screen contains a 1440×900 app viewport.
The earlier exploration (`00b`, `22a`, `40a`–`40c`) remains at y=17,340.

## Keep the existing rows

The normal split keeps its current structure:

- The workspace name and Open sit above chat; the tool tabs and joined PR control
  sit above the right workspace on the same baseline.
- Conversation tabs keep their existing second row above the chat messages.

Only the right workspace's visibility and expansion controls are being placed.
Hide sits beside Open in the split. When collapsed, Show sits at the far right of
the workspace header, after the PR/branch control.
In the expanded view, Hide workspace is a single icon before the tool tabs.
Expand/Restore sits at the far right of the content's existing action row, below
the tool tabs. No new header row or session-navigation change is needed.

## The controls

| Right workspace  | In the top row                   | In the content action row | Result                                                                                   |
| ---------------- | -------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Open beside chat | Hide workspace, beside Open      | Expand workspace          | Hide reveals full chat and tool shortcuts. Expand gives the tool the workspace area.     |
| Collapsed        | Show workspace, at the far right | —                         | Reopens the last selected tool beside chat.                                              |
| Expanded         | Hide workspace, before tool tabs | Restore split             | Hide returns to full chat. Restore returns to chat and tools at the current split width. |

Show/Hide controls whether the right workspace is visible. Its position follows the
layout: beside Open in the split, at the far right in chat-only, and before the tool
tabs when expanded. Expand/Restore controls
how much space visible content uses. In Changes, it shares the existing All changes
/ Review Changes row. It remains at that row's right edge after expansion. The
other tools use the trailing end of their existing action toolbar. Files, Terminal,
Browser, Simulator, Apps and Agent use the same control. Loading, failure and cloud
startup states keep it available. Cached native panels stay mounted but hidden
beneath cloud gates, including their controls.

The project sidebar retains its own controls. Expanded means using the workspace
area, with the project sidebar still visible; it is not operating-system full
screen. Use tooltips and visible keyboard focus for these icon buttons.

The expanded view omits the workspace title and Open. Keep the same Hide workspace
icon as the first item, followed by the tool tabs; the joined PR/branch button stays
at the right. The toolbar shares the content panel's left edge. Do not move the
omitted controls onto another row. Hide returns directly to full chat, while Restore
returns to the split and restores the normal workspace header. Both use the same
existing layout states; they are not duplicate Restore buttons. The selected
workspace remains identifiable in the project sidebar.

The existing joined, colored Create PR / branch selector remains. Session tabs,
conversation switching, drafts and the selected session retain their current behavior.

## Icon weight

Lucide uses one 1.5 stroke on its 24-unit viewBox, set by `.lucide` in the base
layer of `global.css`. Layout controls render at 16px in a 28px button. Existing
icon sizes are unchanged. Brand marks and custom status illustrations retain their
own geometry; the large success check uses an explicit utility override.

Pencil's Lucide icon node does not expose stroke width. The current workspace
screens, controls board and iconography foundation use the installed Lucide SVG
geometry as path overrides, with a 1px rendered stroke at 16px. Older explorations
and generic icon components retain native icon nodes so their glyph overrides remain
editable. Application code keeps the normal Lucide components.

The weight was chosen against the supplied visual references. Direct inspection of
the installed Codex app was blocked by Computer Use, so an exact internal match is
not claimed.

## Tool access

List every available tool directly: Changes, Files, Terminal, Browser, Simulator,
Apps and Agent. There is no More menu in the shortcut list or tool tabs. Use the
existing `content-tabs.ts` registry and availability rules. Environment remains a
link to settings for this repository, not another content tab.

Opening a file from chat can reveal its tool. Incoming agent events update content
without reopening a panel the user collapsed. Changes filters and file headings stay
inside Changes; they do not become new workspace navigation rows.

## State and ownership

`workspaceLayoutStore` owns one per-workspace `panelMode`: `split`, `chat`, or
`content`. It replaces independent collapse flags. `WorkspacePanels` owns resizable
geometry and remembers the most recent split width in memory; no saved size history
or browser-specific layout snapshot is needed. Browser expansion uses this same mode
and never changes the project sidebar. The obsolete vertical CHAT/CONTENT strips
and their size observer are removed.

`SessionTabBar` and native terminal/browser caches keep their existing owners.
Both panes remain mounted. Hidden panes are invisible and inert, and native views
receive their visibility explicitly. `openContentTab` reveals a tool for a user action;
`setActiveContentTab` lets background events update the selection without reopening it.

The focused browser regression journey covers all tools, drafts and DOM preservation,
resizing, view persistence, workspace switching, keyboard controls, cloud gates, Files
retry and mobile layout. Native desktop checks exercise a live shell and embedded
browser. No backend, protocol or session-model change is required.
