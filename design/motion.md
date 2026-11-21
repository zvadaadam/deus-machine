# Motion

When something changes in Deus, show where it went so the person can keep working.
Use one tempo, one highlight per list of choices, and reserve space for state changes so nothing jumps.

## Tempo

| Tier       | Enter |  Exit | What belongs here                                                                        |
| ---------- | ----: | ----: | ---------------------------------------------------------------------------------------- |
| `fast`     |  80ms |  60ms | Hover, press, icon swaps, tooltips, the row highlight and command lists you type into    |
| `moderate` | 160ms | 120ms | Menus, selects, popovers, hover cards and local height changes                           |
| `slow`     | 240ms | 160ms | Ordinary dialogs, sheets, their backdrops, layout panels and page-sized onboarding steps |

```text
Is it a loop or a progress display, such as a spinner, shimmer or playback bar?
├─ Yes → Keep its own timing. List any hand-written timing in the fence with its reason.
└─ No → Is it a command list you type into?
   ├─ Yes → fast. Typing starts as the palette, GitHub picker or / and @ suggestions open.
   └─ Otherwise, how much moves?
      ├─ One control, icon or tooltip → fast.
      ├─ A small surface or details opening below a row → moderate.
      └─ A modal surface, a layout panel or a whole step → slow.
```

```text
What is the movement for?
├─ Enters, leaves or answers hover or press → use the default quartic ease-out, --tempo-ease.
└─ Already on screen and resizing or moving in place → use ease-move, or var(--ease-move) in CSS.
```

Resize a mounted panel on `slow` in both directions (240ms). Give it a gentle start so text has time to reflow.
In the first 16.7ms of the same collapse, the chat grew about 160px with quart and 29px with `ease-move`.
During a divider drag, turn the transition off so the edge stays under the pointer.
Opening details uses the entrance curve. Switch workspace, chat or tab content immediately. [Panel rule and tokens](../apps/web/src/global.css)

- The collapsed desktop sidebar opens over the page on hover. Use one `transition` on its container. The flyout's `translate` and `opacity` use `--tempo-ease` for 240ms in and 160ms out. The toggle changes layout, so `left`, `right` and `width` use `--ease-move` for 240ms in either direction. [Sidebar](../apps/web/src/components/ui/sidebar.tsx#L316)
- A bare `transition-colors` or `transition-opacity` already gives fast feedback, 80ms in either direction. Name the properties that change. Add `tempo-moderate` or `tempo-slow` for a larger change. [CSS utilities](../apps/web/src/global.css)
- When a surface leaves, use its tier's exit. Give its backdrop the same enter and exit times so it stays visible as long as the surface. Command lists and their backdrops use 80/60ms. [CommandDialog](../apps/web/src/components/ui/command.tsx) · [DialogOverlay](../apps/web/src/components/ui/dialog.tsx)
- In a keyframe class, read the tokens. A menu uses `data-[state=open]:animate-[dropdown-enter_var(--tempo-moderate)_var(--tempo-ease)]` and `data-[state=closed]:animate-[dropdown-exit_var(--tempo-moderate-exit)_var(--tempo-ease)]`. [DropdownMenuContent](../apps/web/src/components/ui/dropdown-menu.tsx)
- In Framer use `transition={tempo.moderate}` and `exit={{ opacity: 0, transition: tempo.moderate.exit }}`. Each tier supplies the move curve for layout changes. Only the pairing success mark uses a spring (stiffness 300, damping 20) to confirm the device is paired. [Tempo](../apps/web/src/shared/lib/tempo.ts) · [Chat](../apps/web/src/features/session/ui/Chat.tsx) · [Pairing success](../apps/web/src/features/auth/ui/PairGatePage.tsx)
- Stage page entrances with `enter-step`. The first sibling starts at step 0. Use `[--step:1]`, `[--step:2]` and so on for whole 60ms delays. [ServerOfflinePage](../apps/web/src/features/connection/ui/ServerOfflinePage.tsx)
- For details that open to their content height, put `Collapse` inside `AnimatePresence`. It defaults to moderate and stays mounted for the exit. The composer's two suggestion lists pass `tier="fast"`. [Collapse](../apps/web/src/components/ui/collapse.tsx) · [MessageInput](../apps/web/src/features/session/ui/MessageInput.tsx)

Use the chat activity header's current class when reviewing a control. [TurnStatsHeader](../apps/web/src/features/session/ui/TurnStatsHeader.tsx)

```tsx
"transition-opacity"; // Correct
"transition-opacity duration-150 ease-out"; // Incorrect, the former header class
```

## Reduced motion

Keep the fade. Shared enter and exit keyframes read `--tempo-transform`, which becomes `none` under reduced motion.
The global rule limits CSS transitions to opacity and color properties. Standard spinners, pulses and shimmers stop.
Put a custom CSS loop under `motion-safe:` so it can rest too. [CSS media rule](../apps/web/src/global.css) · [Pairing dots](../apps/web/src/features/auth/ui/PairGatePage.tsx)

`MotionConfig reducedMotion="user"` handles Framer transforms and layout changes. An explicit Framer height or
another moving numeric property still needs a reduced-motion target. Use `Collapse` to snap the height and
fade the content, or check `useReducedMotion()` where you animate the value yourself. [App](../apps/web/src/app/App.tsx) · [Long message height](../apps/web/src/features/session/ui/MessageItem.tsx)

## Glide

Use one `Glide` where the pointer travels between rows that offer the same kind of choice.
Menus, selects, command lists, sidebar rows and navigation lists qualify. The shared menu, select and command list supply their own highlights by default.
Dropdown and submenu content always host their highlights and take no `asChild`. [DropdownMenuContent](../apps/web/src/components/ui/dropdown-menu.tsx#L33) · [DropdownMenuSubContent](../apps/web/src/components/ui/dropdown-menu.tsx#L215)

Keep per-row hover in the transcript, on cards separated by gutters, in another library's virtual rows,
and where results move under a resting pointer. A travelling fill could point at the wrong item.
The file tree leaves hover to Pierre. The composer's changing file matches keep their own row fill. [FileTree](../apps/web/src/features/file-browser/ui/components/FileTree.tsx) · [FileMentionPopover](../apps/web/src/features/session/ui/FileMentionPopover.tsx)

```text
Who picks the active row?
├─ Radix menu or select → follow="data-highlighted".
├─ cmdk → follow="data-selected". Its true marker identifies what Enter will choose.
└─ App-owned pointer list → pass rows with the row selector. Keep keyboard focus visible on the row.
```

Copy the matching call. The first two reuse the menu fill. Settings supplies its own fill and active-row selector. [Select](../apps/web/src/components/ui/select.tsx) · [CommandList](../apps/web/src/components/ui/command.tsx) · [SettingsSidebar](../apps/web/src/features/settings/ui/SettingsSidebar.tsx)

```tsx
<Glide follow="data-highlighted" className="bg-accent rounded-lg" />
<Glide follow="data-selected" className="bg-accent rounded-lg" />
<Glide
  rows="[data-sidebar=menu-button]"
  selected="[data-active=true]"
  className="bg-sidebar-accent rounded-lg"
/>
```

- Mount one fill inside each scrolling, clipping list or column so it follows the rows as they scroll. Give a custom host `relative isolate` so the fill paints above its background and below the labels. The model picker gives each column a fill. cmdk uses `contain-paint` on its inner list sizer so filtered rows cannot hold the list scrolled down. [ModelPicker](../apps/web/src/features/session/ui/ModelPicker.tsx) · [CommandList](../apps/web/src/components/ui/command.tsx)
- Pass the list's own fill and radius in `className`. The workspace sidebar uses `bg-foreground/[0.04] rounded-lg`. Remove the row's old hover fill so the two paints cannot overlap. [AppSidebar](../apps/web/src/features/sidebar/ui/AppSidebar.tsx)
- Use `selected` for rows that already paint their own fill, such as an active navigation row or an open submenu. Destructive menu rows also own their focus tint. Reuse `SelectItem` for checked options. It reserves a slot for the tick and leaves the row eligible. Excluding checked rows once made a Select open with nothing lit on the option Enter would choose. [DropdownMenuGlide](../apps/web/src/components/ui/dropdown-menu.tsx) · [SelectItem](../apps/web/src/components/ui/select.tsx)
- In `follow` mode, show the library's marked row whenever one exists, on every device and wherever the pointer is. Keyboard and touch snap to the marker so the visible row matches Enter. Only pointer travel glides. [Glide](../apps/web/src/components/ui/glide.tsx#L28)
- In `rows` mode, keep the host only as tall as its rows. Settings uses `flex-initial`. The narrow seam between rows holds the last highlight. Moving into open space clears it. Touch has no hover in this mode. [SettingsSidebar](../apps/web/src/features/settings/ui/SettingsSidebar.tsx#L65) · [Glide](../apps/web/src/components/ui/glide.tsx#L83)
- Fade in place on first entry and final exit. Once the fill reaches zero opacity, clear its position and size so a removed row adds nothing to the scroll range. Under reduced motion, keep the fade and set travel to zero. [Glide](../apps/web/src/components/ui/glide.tsx#L23)
- Never key `:has()` or `group-has-*` on highlight, hover or focus. The dropdown's old `group-has-[[data-variant=destructive][data-highlighted]]/menu:bg-destructive-tint` restyled a median 2,256 elements in 19.6ms per pointer change. Use `data-[variant=destructive]:focus:bg-destructive-tint` on the row. It restyled 14 in 1.4ms. [Destructive menu row](../apps/web/src/components/ui/dropdown-menu.tsx)

## Nothing jumps

- When only the selected tab shows a label, keep the trigger and label mounted. Switch the panel on click and resize the strip on `tempo-moderate ease-move`. Fade the incoming label in over 160ms and the outgoing label out over 60ms on `ease-move` so the text follows its width. Selecting Files used to move Terminal 23.78px in one frame. With reduced motion, both the strip and the label switch immediately. [ContentTabBar](../apps/web/src/app/layouts/ContentTabBar.tsx#L61)
- When selection changes the weight of a content-sized label, put `data-medium-label={label}` on its text. A hidden copy at medium weight reserves its width. Fixed-width rows already have room. Selecting the second item moved a neighbouring session pill 0.48px, underlined tab 0.58px, Customize category 2.06px and automation filter 0.38px on macOS. All four now move 0px. [Width rule](../apps/web/src/global.css) · [TabPill](../apps/web/src/components/ui/tab-pill.tsx) · [TabsTrigger](../apps/web/src/components/ui/tabs.tsx)
- For a copy acknowledgement, keep both glyphs in one `CopyIcon` cell and change `copied` only after the clipboard write succeeds. The response footer keeps its 12×12px cell through the 80ms entrance and 60ms exit. Reduced motion keeps the cross-fade. Actions with a single glyph can keep it in place. [CopyIcon](../apps/web/src/components/ui/copy-icon.tsx) · [useCopyToClipboard](../apps/web/src/shared/hooks/useCopyToClipboard.ts)
- Use `Skeleton` when a loading row needs to hold the content's space. It reserves the box immediately, waits 160ms and fades in over 80ms. Quick reads paint only the data. Slower reads pulse after the fade, or stay still under reduced motion. Render cached data directly. [Skeleton](../apps/web/src/components/ui/skeleton.tsx) · [Customize loading grid](../apps/web/src/features/customize/ui/CustomizePage.tsx)

The response footer's former conditional replaced the glyph in one frame. [TurnFooter](../apps/web/src/features/session/ui/TurnFooter.tsx)

```tsx
<CopyIcon copied={copied} className="size-3" />; // Correct
{
  copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />;
} // Incorrect, former footer
```

## What the tests hold

- The fence rejects raw UI timings, curves and `transition-all`. Give each hand-written loop timing a reason in its file's allowlist. [Tempo fence](../test/unit/shared/tempo-fence.test.ts)
- The parity test holds all six CSS durations, both curves and the 60ms step equal to their Framer values. [Tempo parity](../test/unit/shared/tempo.test.ts)
- The browser runner checks pointer travel, keyboard targets, lit checked rows and touch. It measures fixed bounds on press, label and icon changes, and reduced-motion fades. The panel switches on frame one, the spinner stops under reduced motion and the skeleton stays hidden for 160ms. [Controls browser runner](../test/e2e/controls.browser.mjs)
