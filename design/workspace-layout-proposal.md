# Workspace layout proposal

Design only, awaiting product review. The app still uses its current layout.

The proposal is in `deus.pen`. The first layout exploration (`00b`, `22a`, `40a`–`40c`)
is at y=17,340. The newer compact-header alternatives (`00c`, `22b`, `40d`–`40f`) start
at y=18,640. Each screen contains a 1440×900 app viewport below a design annotation.
Existing shipped screens and the first exploration are preserved.

## Compact header alternatives

The first proposal stacks a 52px workspace header above 40px conversation/tool tabs.
The newer alternatives put navigation on one 44px baseline, recovering 48px for
content. Each header belongs to its pane: conversation controls above chat and tool
tabs above the tool content. They must follow the pane divider rather than compete
for space in one global flex row.

| Direction                      | Conversation navigation                                                   | Tradeoff                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A · Visible tabs · recommended | Existing session tabs sit above chat in its header.                       | One-click switching and visible activity; needs a usable minimum chat-pane width.                     |
| B · Conversation picker        | The current conversation opens a selector.                                | More room for workspace identity, but other conversations and their activity are hidden until opened. |
| C · Sidebar conversations      | Conversations appear under the selected workspace in the project sidebar. | Conversations stay visible, but every workspace gains a deeper navigation hierarchy.                  |

All three keep direct tool access and the joined Create PR / branch control. A is the
smallest change to the current interaction model. `22b` checks its closed and
1100px-window headers. At that width, chat or the selected tool fills the workspace;
there is insufficient room for two useful panes with all controls. Opening a tool
uses the workspace width; Close returns to chat. Do not clip a session chip or let
tool tabs spill over chat to force a split. These are static layout checks; behavior
still needs implementation and validation.

Changes filters and file headings belong to the selected tool's content. They do not
become additional workspace navigation rows. Keep headers inside the existing
resizable pane containers, using the same height. Move the existing session-tab
presentation into the chat header; reuse `useChatTabs` without a second selected-session
state. There is no need for a separate global header or a width-synchronization mechanism.

## The three views

| View     | What appears                                                            | Controls                                                                 |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chat     | Project sidebar, chat, and a quiet list of available tools on the right | A tool link opens that tool. Open panel restores the last selected tool. |
| Split    | Project sidebar, chat, and an open tool in a resizable split            | Expand gives the tool the workspace width. Close returns to Chat.        |
| Expanded | Project sidebar and the selected tool                                   | Restore brings back the previous split. Close returns to Chat.           |

There is no separate collapse-chat action and no vertical CHAT or CONTENT strip.
Expanded refers to the workspace area; it does not enter operating-system full screen.
Restore is available when the window can accommodate both panes.

In the compact alternatives, workspace identity, conversation navigation and Open
sit above chat. Tools, Expand/Restore, Close and the joined PR control sit above the
tool pane on the same baseline. When tools are closed, the chat header uses the
workspace width and retains PR actions and Open panel. Every icon has a tooltip and
visible keyboard focus.
The reading column is capped at 720px when chat has room; the initial split gives half
the workspace to chat.

## Tool access

The shortcut list and panel tabs show every available tool directly, with no More
menu: Changes, Files, Terminal, Browser, Simulator, Apps and Agent. Both use the existing
`content-tabs.ts` registry and its visibility rules; Browser, Simulator and Apps appear
only when supported and enabled. The mockups show a workspace with all tools available.
Changes can show its existing file count. Environment opens settings for this
repository, rather than becoming a new content tab.

Opening a file or other resource from chat reveals its tool. Incoming agent events
update the content without opening a panel the user has closed. The sidebar keeps
showing the agent's working state when a tool is expanded.

On a narrow desktop window, the shortcut list can disappear while Open panel remains
available in the header. Avoid squeezing two panes below usable widths. A tool can
occupy the workspace width there, with Close returning to chat. The direct cloud web
lane remains chat-only when its capabilities expose no tools. Mobile navigation is
outside this proposal.

## Implementation after design approval

The current layout independently stores chat/content collapse flags, converts 36px
strips into percentages, and synchronizes both flags with imperative panel handles.
That is the main cleanup opportunity in `MainContent.tsx`.

Replace those two collapse flags with one view state: `chat`, `split`, or `expanded`.
Keep the existing selected tab, per-workspace persistence, saved split width and
resizable-panel library. Retire `CollapsedPanelStrips.tsx` and
`useCollapsedSizePercent.ts` when their callers are replaced. Revisit the existing
panel shortcuts together with the new controls.

Hiding a view must preserve drafts, conversation scroll, selected files, terminal
sessions and browser state. It must not stop agent work or restart tools. Verify
open → expand → restore → close → reopen, workspace switching and window resizing
before shipping. No backend or AGNT protocol change is needed for this layout.
