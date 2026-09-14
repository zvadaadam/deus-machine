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

Only the right workspace's expand/collapse controls are being placed. They join its
existing toolbar, after the joined Create PR / branch button. No new header row,
conversation picker, sidebar conversation tree, or session-navigation move is needed.

## The controls

| Right workspace  | Controls                                         | Result                                                                                                   |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Open beside chat | Expand workspace; Collapse workspace             | Expand gives the tool the workspace area. Collapse reveals chat and the tool shortcuts.                  |
| Collapsed        | Show workspace, in the existing workspace header | Reopens the last selected tool beside chat.                                                              |
| Expanded         | Restore split; Collapse workspace                | Restore brings back chat with its existing session tabs and saved split width. Collapse returns to chat. |

Expand/Restore and Collapse stay adjacent at the end of the tool toolbar. The
project sidebar retains its own controls. Expanded means using the workspace area,
with the project sidebar still visible; it is not operating-system full screen.
Use tooltips and visible keyboard focus for these icon buttons.

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

Keep `SessionTabBar` and its state owner where they are. Add the right workspace
controls to the existing content-panel header. Reuse the selected tool, saved split
width, per-workspace layout state and resizable-panel library. The earlier request
to replace the vertical collapsed CHAT/CONTENT strips with these controls still applies.

Hiding or expanding a pane must preserve conversation scroll, drafts, selected files,
terminal/browser state and running agents. Verify open → expand → restore → collapse
→ reopen, workspace switching and resizing with all available tools shown. The design
checks placement, not live interaction. No backend, protocol or session-model change
is needed for this layout.
