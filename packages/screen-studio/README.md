# @deus/screen-studio

Record what an agent does — a browser tab, an iOS Simulator, a display — into a
**bundle** of original media and timed evidence. Then render polished, chaptered
videos from it as many times as you like: waits sped up or cut, the camera on
each action, a pointer or touches, a window frame on a background.

The agent keeps using its own tools (agent-browser, Playwright, device-use,
agent-device, …). Screen Studio records the screen and takes a note of each
action; it never drives the app and never injects input.

```text
 your tools ──control──▶ tab / simulator / display
                              │ pictures
                              ▼
 actions, chapters ──▶ screen-studio ──▶ bundle ──render──▶ walkthrough.mp4 (+ .json plan, .vtt chapters)
                                            └──────────────▶ any editor (plain MP4 + JSON)
```

## Quick start (CLI)

Requires FFmpeg with libx264. Styled renders use `@napi-rs/canvas` (an optional
dependency); without it, renders fall back to FFmpeg-only.

```sh
screen-studio doctor                  # what is installed, what each piece enables
screen-studio sources                 # recordable sources and their IDs

screen-studio start --source agent-browser:demo --out ./captures/login --max-duration 3m
#   …the agent works with its usual tools; report what it does:
screen-studio chapter ./captures/login "Sign in"
screen-studio action  ./captures/login --type click --rect 412,288,120,40 --label "Sign in"
screen-studio focus   ./captures/login --rect 900,120,320,200 --label "Welcome banner"
screen-studio stop    ./captures/login

screen-studio render  ./captures/login --preset walkthrough   # or demo, review
screen-studio inspect ./captures/login --contact-sheet        # a grid of frames to check
```

Every command prints one JSON object on stdout — including failures, as
`{"ok":false,"error":{"code","message","hint"}}` — and logs on stderr. `start`
returns only once video is actually flowing, and hands the recorder to a
detached worker, so `start`, `chapter` and `stop` can be separate processes.
`stop` is idempotent, works during a slow start, and only signals a process it
has verified is that recording's worker; a recording an app or MCP server owns
in-process is stopped there. A recording stops itself at `--max-duration` (default
10 minutes) or `--max-size`, whatever the agent does.

For a scripted take, `record` runs in the foreground until the duration, Ctrl-C,
or a command exits:

```sh
screen-studio record --source ios-simulator:booted --out ./captures/onboarding -- bun demo.ts
# demo.ts can call: screen-studio chapter "$SCREEN_STUDIO_BUNDLE" "Welcome"
```

## Sources

| Source ID                         | Captures                        | Backend                 | Notes                                                                                                                               |
| --------------------------------- | ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser:<session>`         | The tab that session is driving | DevTools screencast     | Resolves `get cdp-url` + current URL. `agent-browser:<namespace>/<session>` works too.                                              |
| `browser:<endpoint>`              | One Chromium tab                | DevTools screencast     | `http://127.0.0.1:9222`, a port, a browser or page `ws://…/devtools/…` URL. `--url-contains` picks the tab. Electron webviews work. |
| `ios-simulator:<udid>` / `booted` | The simulated screen, no chrome | `simctl io recordVideo` | Finds Xcode outside `/Applications` (e.g. `~/Downloads`). Viewport in iOS points from the device profile.                           |
| `display:<n>`                     | A macOS display                 | FFmpeg AVFoundation     | Needs Screen Recording permission for the app running the command.                                                                  |
| `test-pattern:<WxH>`              | A synthetic moving pattern      | FFmpeg lavfi            | For tests and demos.                                                                                                                |
| `screen-studio import <video>`    | An existing video (+ events)    | Copy                    | Bring footage from any tool into the same editor: agent-device telemetry and Cua driver trajectories are read directly.             |

**Sharing a tab is fine.** Two screencasts on one tab each kept 60 fps, and
agent-browser's own viewer stream kept 60 fps while a recording ran. When an
agent-browser session already streams its viewport, `agent-browser:<session>`
joins that stream (`browser-stream:<ws-url>` does it directly) so the browser
doesn't encode frames twice.

**Background tabs are not painted.** A hidden tab, a hidden `<webview>` or a
minimized window sends no frames, so the recording holds a frozen picture.
The page observer notices — animation frames stop while timers still run —
and records an `unseen` span with frame-exact edges; edits cut it, actions
inside it are left out, and the render warns. Keep the recorded tab visible.

## Reporting actions

**Browser recordings report their own actions.** The browser source installs
passive listeners in the recorded tab and records every trusted click, tap,
key press, typing burst, scroll and navigation with the target's exact box —
whichever tool (or person) drives the page. Typed text is never read, only
its length. Pass `observe: false` in the source spec when a controller
reports actions itself. Other sources need actions reported:

An action is a moment and, ideally, a place:

```jsonc
{
  "kind": "action",
  "type": "click",
  "at": 1793945714652,
  "endAt": 1793945714781,
  "rect": { "x": 412, "y": 288, "width": 120, "height": 40 },
  "label": "Sign in",
}
```

- `at`/`endAt` are epoch milliseconds on the recording machine — the same clock
  the manifest maps to media time. Report the start and the completion: the edit
  keeps everything from shortly before the start until the result has been on
  screen long enough to read.
- Coordinates are in the source's viewport: CSS pixels for browsers, iOS points
  for simulators. A tool that reports in another space adds `"space": {"width",
"height"}` and Screen Studio scales.
- Types: `click`, `double-click`, `right-click`, `hover`, `type`, `key`, `scroll`,
  `navigate`, `drag`, `tap`, `long-press`, `swipe`, `pinch`, `other`. Drags and
  swipes can carry a `path`.
- Typed text is never needed; store a label instead (Deus records `[12 chars]`).

Adapters can stream events: `screen-studio action DIR --stdin` reads JSON Lines.

Footage another tool recorded comes in with its actions:

```sh
screen-studio import demo.mp4 --out ./captures/ios --agent-device-telemetry demo.telemetry.json
screen-studio import --cua-trajectory ./trajectory --out ./captures/desktop
```

A Cua trajectory's turns become actions with their times and the tool's own
summary as the label (typed text is counted, never copied); refused turns
are left out. Its click points are relative to a window screenshot, so they
carry no place on the display: the edit cuts the waits between turns and the
camera stays wide.

Intent beyond actions:

| Event     | Meaning                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `chapter` | A section starts now. Chapters follow their picture through every edit.                                             |
| `focus`   | The camera should show this region — usually a result away from the click. A semantic hint, not camera coordinates. |
| `hold`    | Keep the next N seconds at normal speed.                                                                            |
| `note`    | An annotation for editors.                                                                                          |

## Rendering

```sh
screen-studio render DIR --preset demo --target-duration 30s
screen-studio render DIR --plan        # write the decisions without rendering
```

| Preset        | Pacing                                    | Camera     | Look                                                |
| ------------- | ----------------------------------------- | ---------- | --------------------------------------------------- |
| `walkthrough` | still waits 6×, motion 2×, long waits cut | up to 1.6× | Frame on a gradient, 1920×1080                      |
| `demo`        | still waits 8×, long waits cut sooner     | up to 1.8× | Same                                                |
| `replay`      | same as walkthrough                       | static     | Source size, pointer only — session replays, audits |
| `review`      | original timing                           | static     | Source size, pointer markers only                   |

Portrait sources (phones) get a portrait canvas, 1080×1920, unless `--size`
is given. Source-size output keeps within a 1920-pixel long edge.

Everything that decides the picture is written to `renders/<name>.json` before
any frame is drawn, with a reason for each choice:

- **Pacing.** Each action is kept at 1× from 0.7 s before it starts until 1.2 s
  after it completes, so its result is seen; so are holds, focus hints and the
  first second of each chapter. Everything else is a wait. Motion analysis
  (FFmpeg `freezedetect` on a 256-px copy, so carets and spinners count as
  still) separates still waits from moving ones: an animation plays at 2×, a
  frozen screen at 6×. A wait that would still take more than 2 s keeps a
  sped-up head and tail and cuts the middle. `--target-duration` tightens
  pacing step by step and reports `targetMet: false` rather than cutting actions.
- **Edit map.** One map from source to output time drives the FFmpeg retime,
  the camera, the pointer, chapters and event times, so they cannot drift.
- **Camera.** Actions close in time and on screen share one shot that fits all
  their targets; navigation and scrolling go wide; a focus hint overrides
  action framing while it lasts; shots that would not settle (< 700 ms) are
  dropped with a warning. Springs run in output time, zoom in log space.
  Phone recordings keep a static camera by default (`--zoom` to override):
  zooming into a narrow screen crops the UI sideways.
- **Pointer.** Generated between recorded targets — travel, a short rest,
  press, ripple, then a fade so results aren't covered — and labelled as
  presentation in the plan, never as an observed path. Phones get touch
  indicators instead. Default pointer: the Cua cursor in black with a white
  outline (see NOTICE).
- **Results.** Motion analysis marks each moment the picture changes after a
  still stretch. A change 0.3–30 s after an action is that action's result:
  it plays at 1× with reading time, and the camera frames the region that
  changed (or goes wide when most of the screen did) — measured only for
  results, so long recordings stay cheap. A `focus` hint near it takes
  precedence. No tool has to report it.
- **Unseen spans** (hidden tab, minimized window) are cut in every edited
  preset; `review` keeps original timing, frozen frames and all.
- **Chapters** are embedded in the MP4 and written as WebVTT; a chapter whose
  moment was cut starts where the cut lands.

Renders stream one frame at a time (flat memory for any length). Painting
costs ~5.5 ms of main-thread time per 1080p frame; decoding, compression and
encoding run off-thread or in FFmpeg — safe inside a host that also serves an
app. The original media is never modified.

## The bundle

```text
login/
  manifest.json      source, clock, geometry, media facts, outcome
  events.jsonl       actions, chapters, holds, focus, notes (append-only)
  media/screen.mp4   the original capture
  analysis/          derived and replaceable (motion ranges, contact sheets)
  renders/           walkthrough.mp4 · walkthrough.json (plan + edit map) · .vtt · .jpg
  logs/
```

`manifest.clock.mediaStartEpochMs` is media time zero on the machine clock;
`mediaMs = event.at - mediaStartEpochMs`, within `uncertaintyMs`. The browser
backend owns its clock outright: a constant-rate pump re-emits the latest
frame every tick, so frame _k_ is on screen at start + _k_/fps and still pages
cost almost nothing to store. Media is written as fragmented MP4 while
recording, so a killed recorder leaves playable footage; `stop` recovers it.

## SDK

```ts
import { startRecording, renderBundle } from "@deus/screen-studio";

const recording = await startRecording({
  source: "agent-browser:demo",
  out: "./captures/login",
  maxDurationMs: 3 * 60_000,
});
await recording.chapter("Sign in");
const started = Date.now();
await page.click("#sign-in"); // your automation
await recording.action({
  type: "click",
  at: started,
  endAt: Date.now(),
  rect: { x: 412, y: 288, width: 120, height: 40 },
});
await recording.focus({ x: 900, y: 120, width: 320, height: 200 }, { label: "Welcome banner" });
const manifest = await recording.stop(); // finalized, verified media

const video = await renderBundle(recording.dir, { preset: "walkthrough" });
// video.outputPath, video.chapters, video.events, video.plan
```

Also exported: `listSources`, `importVideo`, `inspectBundle`, `doctor`, the
bundle schema (zod), and the planning pieces (`planPacing`, `planShots`,
`EditMap`, …) for editors that want to make their own choices.

## Agent tools for any host

The tools an agent sees are defined once, in the package: `recording_start`,
`recording_chapter`, `recording_focus`, `recording_hold`, `recording_status`,
`recording_stop` (and `recording_action` for sources that can't observe
themselves). A host registers them with its own MCP layer and supplies only
what is its own:

```ts
import { createAgentTools } from "@deus/screen-studio";

const recording = createAgentTools({
  // What "record the browser" means in this session.
  resolveSource: async ({ target }) =>
    target === "simulator" ? "ios-simulator:booted" : "agent-browser:my-session",
  bundleDir: () => `/data/recordings/${crypto.randomUUID()}`,
  resolveRef: (ref) => myBrowser.boxOf(ref), // optional: focus by element ref
  onStateChange: (state, rec) => emit({ state, id: rec.id }), // optional: tell your UI
});
for (const t of recording.tools) registerTool(t.name, t.description, t.inputSchema, t.handler);
```

Deus registers exactly this (`apps/agent-server/agents/deus-tools/recording.ts`).
`recording_stop` returns the rendered video, chapters and events.

## Agent skill

`skills/screen-studio/SKILL.md` teaches an agent when to record, the CLI
workflow, which sources report their own actions, presets, and what to check
before sharing. `screen-studio skill` prints it, so any agent with a shell can
load it.

## MCP and CLI

`screen-studio-mcp` serves the same agent tools over stdio, letting the agent
name any source, plus `screen_studio_sources`, `recording_render` (re-render or
`plan`), and `recording_inspect` (returns a contact sheet as an image). The
`screen-studio` CLI covers the same operations from a shell.

## Not yet

- Native window capture (a ScreenCaptureKit helper) and Windows/Linux desktops.
  Desktop agents that work in the background (Cua) act on windows a display
  recording may not show; record an agent-owned display or VM instead.
- Places for Cua actions (needs the window's frame on screen at each turn).
- Audio.
- Following a browser into a new tab: a closed tab ends the recording.
- Physical iOS devices and Android.
