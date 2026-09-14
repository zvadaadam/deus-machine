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
Show/Hide sits beside Open in the workspace header. Expand/Restore sits at the far
right of the content's existing action row, below the tool tabs. No new header row
or session-navigation change is needed.

## The controls

| Right workspace  | Beside Open    | In the content action row | Result                                                                                        |
| ---------------- | -------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| Open beside chat | Hide workspace | Expand workspace          | Hide reveals chat and tool shortcuts. Expand gives the tool the workspace area.               |
| Collapsed        | Show workspace | —                         | Reopens the last selected tool beside chat.                                                   |
| Expanded         | Hide workspace | Restore split             | Restore brings back chat and its session tabs at the saved split width. Hide returns to chat. |

Show/Hide controls whether the right workspace is visible. Keeping it beside Open
makes the toggle available even when the content is hidden. Expand/Restore controls
how much space visible content uses. In Changes, it shares the existing All changes
/ Review Changes row. It remains at that row's right edge after expansion. The
other content views should use the equivalent end of their own action toolbar;
this proposal draws Changes, so those views still need a placement check.

The project sidebar retains its own controls. Expanded means using the workspace
area, with the project sidebar still visible; it is not operating-system full
screen. Use tooltips and visible keyboard focus for these icon buttons.

The existing joined, colored Create PR / branch selector remains. Session tabs,
conversation switching, drafts and the selected session retain their current behavior.

## Tool access

List every available tool directly: Changes, Files, Terminal, Browser, Simulator,
Apps and Agent. There is no More menu in the shortcut list or tool tabs. Use the
existing `content-tabs.ts` registry and availability rules. Environment remains a
link to settings for this repository, not another content tab.

Opening a file from chat can reveal its tool. Incoming agent events update content
without reopening a panel the user collapsed. Changes filters and file headings stay
inside Changes; they do not become new workspace navigation rows.

## Implementation after design approval

Keep `SessionTabBar` and its state owner where they are. Place Show/Hide alongside
Open and reserve the trailing action slot in the content toolbar for Expand/Restore.
Reuse the selected tool, saved split width, per-workspace layout state and
resizable-panel library. The earlier request to replace the vertical collapsed
CHAT/CONTENT strips with these controls still applies.

Hiding or expanding a pane must preserve conversation scroll, drafts, selected files,
terminal/browser state and running agents. Verify open → expand → restore → collapse
→ reopen, workspace switching and resizing with all available tools shown. The design
checks placement, not live interaction. No backend, protocol or session-model change
is needed for this layout.
