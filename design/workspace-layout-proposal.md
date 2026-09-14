# Right workspace panel

Design only, awaiting product review. The app layout is unchanged.

The current proposal is in `deus.pen`: overview `00c`, controls `22b`, and screens
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

| Right workspace  | In the top row                   | In the content action row | Result                                                                                 |
| ---------------- | -------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Open beside chat | Hide workspace, beside Open      | Expand workspace          | Hide reveals full chat and tool shortcuts. Expand gives the tool the workspace area.   |
| Collapsed        | Show workspace, at the far right | —                         | Reopens the last selected tool beside chat.                                            |
| Expanded         | Hide workspace, before tool tabs | Restore split             | Hide returns to full chat. Restore returns to chat and tools at the saved split width. |

Show/Hide controls whether the right workspace is visible. Its position follows the
layout: beside Open in the split, at the far right in chat-only, and before the tool
tabs when expanded. Expand/Restore controls
how much space visible content uses. In Changes, it shares the existing All changes
/ Review Changes row. It remains at that row's right edge after expansion. The
other content views should use the equivalent end of their own action toolbar;
this proposal draws Changes, so those views still need a placement check.

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

Keep Lucide, which the app already uses. These four layout icons use a 1.5 stroke
on Lucide's 24-unit viewBox, rendered at 16px in the existing 28px button. This is
lighter than Lucide's default 2 stroke without reducing the click target. Apply
the same weight to Show, Hide, Expand and Restore; no new icon library is needed.

Pencil's Lucide icon node does not expose stroke width. The current proposal uses
the installed Lucide SVG geometry as path overrides, with a 1px rendered stroke
at 16px, to match `strokeWidth={1.5}` in React. This is a design representation;
implementation should keep the normal Lucide components.

## Tool access

List every available tool directly: Changes, Files, Terminal, Browser, Simulator,
Apps and Agent. There is no More menu in the shortcut list or tool tabs. Use the
existing `content-tabs.ts` registry and availability rules. Environment remains a
link to settings for this repository, not another content tab.

Opening a file from chat can reveal its tool. Incoming agent events update content
without reopening a panel the user collapsed. Changes filters and file headings stay
inside Changes; they do not become new workspace navigation rows.

## Implementation after design approval

Keep `SessionTabBar` and its state owner where they are. Place Hide alongside Open
in the split, Show after PR at the far right when collapsed, and Hide before the
tool tabs when expanded.
Reserve the trailing action slot in the content toolbar for Expand/Restore.
Keep the workspace title and Open hidden in the expanded view.
Reuse the selected tool, saved split width, per-workspace layout state and
resizable-panel library. The earlier request to replace the vertical collapsed
CHAT/CONTENT strips with these controls still applies.

Hiding or expanding a pane must preserve conversation scroll, drafts, selected files,
terminal/browser state and running agents. Verify open → expand → restore → collapse
→ reopen, workspace switching and resizing with all available tools shown. The design
checks placement, not live interaction. No backend, protocol or session-model change
is needed for this layout.
