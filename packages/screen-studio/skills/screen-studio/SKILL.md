---
name: screen-studio
description: Record a polished video of work an agent did in a browser tab, an iOS Simulator or on a desktop, then edit it automatically — waits sped up or cut, the camera on each action and its result, chapters. Use when asked to record, demo, or show a change on video, to attach a walkthrough to a PR, or to turn an agent-device or Cua recording into a shareable video.
---

# Screen Studio

Screen Studio records a screen while you keep using your own tools, then edits
the footage: it keeps each action and the result that follows it at normal
speed, speeds up or cuts the waiting, frames each action, and adds chapters.
It never clicks or types for you.

Every CLI command prints one JSON object; failures are
`{"ok":false,"error":{"code","message","hint"}}` — read the hint.

## When to record

Record a deliberate take **after** the work is done: open the starting page,
then walk through the change the way a reviewer should see it. Don't record an
investigation — it is long, and the edit can only cut waiting, not wrong turns.

## 1. Pick the source

```sh
screen-studio sources        # recordable sources and their IDs
```

| You are driving                     | Source ID                                        |
| ----------------------------------- | ------------------------------------------------ |
| agent-browser                       | `agent-browser:<session>`                        |
| Any Chromium/Electron over DevTools | `browser:<port or ws URL>` (+ `--url-contains`)  |
| iOS Simulator                       | `ios-simulator:booted` or `ios-simulator:<udid>` |
| A macOS display                     | `display:0`                                      |

With the recording tools (`recording_start` …) the host has already decided
the source; just say whether it is the browser or the simulator.

## 2. Record

```sh
screen-studio start --source agent-browser:demo --out ./captures/login --max-duration 3m
screen-studio chapter ./captures/login "Sign in"
#   … do the work with your usual tools …
screen-studio chapter ./captures/login "Dashboard"
#   … more work …
screen-studio stop ./captures/login --render walkthrough
```

- `start` returns once video is flowing. The recording stops itself at
  `--max-duration`, so a forgotten `stop` costs nothing.
- **Browser sources see every click, key press, typing burst, scroll and
  navigation by themselves**, with the element's box. Don't report them.
- **Other sources need actions reported**, right after each one: when it
  started (`--at`, epoch ms; default now), how long it took, and where it
  happened in the source's own coordinates (iOS points for simulators):

  ```sh
  screen-studio action ./captures/onboarding --type tap --x 196 --y 612 \
    --at 1793945714652 --duration 300ms --label "Continue"
  ```

- `chapter` before each section — they become MP4 chapters and WebVTT.
- `focus --rect x,y,w,h` only when the important thing is away from where you
  acted (a toast, a total that updated). Results of actions are found and
  framed automatically.
- `hold --for 2s` keeps the next moment at normal speed (something to read).

## 3. Render

```sh
screen-studio render ./captures/login --preset demo --target-duration 30s
```

| Preset        | For                                                                |
| ------------- | ------------------------------------------------------------------ |
| `walkthrough` | Default. Waits sped up, gentle zoom, window frame on a background. |
| `demo`        | Shortest: waits cut, closer zoom. For sharing.                     |
| `replay`      | Waits sped up, no styling. Session replays and audits.             |
| `review`      | Original timing, no styling. Debugging.                            |

Phone recordings render portrait with a static camera. Re-render as often as
you like: the original is never modified.

## 4. Check before sharing

```sh
screen-studio inspect ./captures/login --contact-sheet --render walkthrough
```

Look at the contact sheet image. Then read `warnings` in the render result:

- **"not painted"** — the tab was hidden or minimized for a while. Those
  stretches are cut from edited presets, and actions inside them are gone.
  Keep the recorded tab visible and record again if they mattered.
- **`targetMet: false`** — actions alone are longer than the target; nothing
  was cut to fake it.
- **dropped shots** — fine; the camera stayed wide where it could not settle.

Share `outputPath` (MP4 with chapters); `thumbnailPath`/`posterPath` is a
still for previews.

## Footage recorded by another tool

```sh
# agent-device (iOS): video + gesture telemetry
screen-studio import demo.mp4 --out ./captures/ios --agent-device-telemetry demo.telemetry.json
# Cua driver trajectory (start_recording with an output_dir)
screen-studio import --cua-trajectory ./trajectory --out ./captures/desktop
# anything else: a video plus JSON Lines of events in media milliseconds
screen-studio import take.mp4 --out ./captures/take --events events.jsonl
```

Then `render` as above. Cua turns carry times and labels but no positions:
the edit cuts the waiting between turns, and the camera stays wide.

## Limits

- One recording at a time per tool set or bundle directory.
- Background browser tabs are not painted; nothing can record them.
- A recorded tab that closes ends the recording.
- No audio.
