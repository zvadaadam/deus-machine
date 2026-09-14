# Buttons and controls

The September 14 update follows the supplied ChatGPT/Codex screenshots: soft
corners, regular system type, neutral primary actions, and restrained feedback.
The screenshots establish the visual direction; they do not expose that app's
internal CSS.

## Shared implementation

`components/ui/button.tsx` owns action variants and sizes. Prefer `Button` for
ordinary actions, including menu triggers and links through `asChild`.
`TabPill` owns session, browser and terminal tabs. Radix owns menu, select and tab
keyboard behavior.

Controls that need their own markup use `control-interaction` from `global.css`:
150ms transitions for color, background, border, shadow and opacity; a 2px
keyboard focus ring; and disabled pointer/opacity behavior. It does not set layout,
dimensions or selected colors. No extra component wrapper is needed.

| Property       | Rule                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Font           | Existing native system stack; Inter is the canvas substitute                                              |
| Toolbar labels | `text-sm` / 12px, regular weight                                                                          |
| Emphasis       | Selected tabs, destructive actions and the rose PR action use medium weight                               |
| Corners        | Existing `rounded-lg`; directional variants for joined controls                                           |
| Primary        | `button-primary` / `button-primary-foreground`: white with dark text in dark mode, reversed in light mode |
| Secondary      | `control-surface` with foreground text; outline adds `border-strong`                                      |
| Hover / press  | Filled controls use surface-hover / surface-pressed; ghost controls use foreground at 5% / 9%             |
| Focus          | Keyboard-only 2px ring; inset on clipped PR halves, contrasting foreground on the filled half             |
| Motion         | No hover growth or press scaling; reduced motion suppresses transitions                                   |

Buttons reuse the existing radius system. `radius-lg` is 10px on Electron versions
without continuous corners. Supporting browsers use
`corner-shape: superellipse(1.5)` with the existing 1.25 scale (12.5px). The canvas
shows the scaled radius with circular arcs, its rendering limitation. There is no
separate control-radius token or class-merging configuration.

Cards, dialogs, avatars, badges and circular Send/Stop controls retain their
appropriate shapes. The joined PR/branch control retains its rose treatment.
Onboarding keeps its dark presentation in either app theme, using
`onboarding-foreground` and `onboarding-contrast` for its labels and controls.

| Button size | Height | Horizontal padding |
| ----------- | ------ | ------------------ |
| `xs`        | 28px   | 10px               |
| `sm`        | 32px   | 12px               |
| Default     | 36px   | 16px               |
| `lg`        | 40px   | 20px               |

Icon variants are square at the corresponding height. Labels use the same padding
with or without icons. Preserve larger existing mobile and onboarding targets;
navigation rows and explanatory text are not toolbar buttons.

## Canvas and validation

Board `10` owns `DS/Button-*`, sizes and icon controls. Board `05` shows default,
hover, pressed, focused and disabled states; board `02` documents motion. Composer,
workspace, settings, onboarding and mobile controls share these rules. Historical
explorations and the landing palette stay separate.

`test/e2e/controls.browser.mjs` checks press geometry, circular overrides, disabled
actions, keyboard focus/menus, select and link behavior, independent tab lifetimes,
reduced motion and mobile touch. It also renders the supplied reference labels
using the actual components for visual comparison. Workspace and usability
journeys cover the application consumers. CI retains screenshots for all three.
