# Workspace layout proposal

Design only, awaiting product review. The app still uses its current layout.

The proposal is in `deus.pen`: overview `00b`, controls `22a`, and screens
`40a`–`40c`. Each screen contains a 1440×900 app viewport below a design annotation.
The new frames are grouped in the proposal lane at y=17,340. Existing shipped
screens and components are preserved.

## The three views

| View     | What appears                                                            | Controls                                                                             |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Chat     | Project sidebar, chat, and a quiet list of available tools on the right | A tool link opens that tool beside chat. Open panel restores the last selected tool. |
| Split    | Project sidebar, chat, and an open tool in a resizable split            | Expand gives the tool the workspace width. Close returns to Chat.                    |
| Expanded | Project sidebar and the selected tool                                   | Restore brings back the previous split. Close returns to Chat.                       |

There is no separate collapse-chat action and no vertical CHAT or CONTENT strip.
Expanded refers to the workspace area; it does not enter operating-system full screen.

The workspace identity, Open action and joined Create PR / branch selector stay in
one header. When the tool panel is closed, Open panel sits at the header's far right.
When it is open, Expand/Restore and Close sit at the right of the tool tab row, directly
above the panel they control. Every icon has a tooltip and visible keyboard focus.
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
