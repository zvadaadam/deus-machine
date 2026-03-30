# @deus/screen-studio

Screen Studio-style camera engine and video compositing for AI agent screen recordings. Turns raw browser sessions into polished videos with auto-zoom, spring physics, device frames, and gradient backgrounds.

Three ways to use it: **SDK** (embed in your app), **CLI** (script from shell), **MCP Server** (any AI agent).

## How it works

1. An AI agent browses a website (clicks, types, scrolls, navigates)
2. Each action feeds the **camera engine** which computes smooth zoom/pan transforms using spring physics
3. The **compositor** applies device frames, backgrounds, and cursor overlays
4. **ffmpeg** (or a canvas) renders the final video

```
Agent events → Camera Engine → Compositor → ffmpeg / Canvas → MP4 / Live preview
(click @e5)    (spring zoom)   (device frame)  (crop+scale)
```

## Install

```bash
bun add @deus/screen-studio
```

Requires **ffmpeg** for video encoding (capture + post-processing). The SDK works without ffmpeg for real-time canvas rendering.

## Quick start

### SDK — real-time preview in a browser

```ts
import { CameraEngine, Compositor, CanvasRenderer } from "@deus/screen-studio";

const engine = new CameraEngine({
  sourceSize: { width: 1920, height: 1080 },
});

const compositor = new Compositor({
  output: { width: 1920, height: 1080 },
  source: { width: 1920, height: 1080 },
  deviceFrame: { type: "browser-chrome", title: "https://example.com" },
  background: { type: "gradient", colors: ["#0f0f23", "#1a1a3e"] },
  cursor: { visible: true, size: 24, showClickRipple: true, rippleDuration: 400 },
});

const renderer = new CanvasRenderer(canvas.getContext("2d")!);

// Feed agent actions
engine.pushEvent({ type: "click", x: 500, y: 300, t: 0 });
engine.pushEvent({ type: "type", x: 500, y: 320, t: 500 });

// Render loop
function frame() {
  const camera = engine.step(1 / 60);
  const cursor = engine.getCursorState();
  const instructions = compositor.computeFrame(camera, cursor);
  renderer.renderFrame(sourceImage, instructions, background);
  requestAnimationFrame(frame);
}
frame();
```

### SDK — post-process with ffmpeg

```ts
import { CameraEngine, generateCropScaleFilter } from "@deus/screen-studio";

const engine = new CameraEngine({
  sourceSize: { width: 1920, height: 1080 },
});

// Batch-feed events
events.forEach((e) => engine.pushEvent(e));

// Generate timeline and ffmpeg filter
const timeline = engine.processTimeline(30, 15); // 30fps, 15 seconds
const filter = generateCropScaleFilter(
  timeline.map((t, i) => ({
    timestamp: i * (1000 / 30),
    camera: t.camera,
    cursor: t.cursor,
  })),
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
);

// Apply with ffmpeg:
// ffmpeg -i raw.mp4 -filter_complex "<filter>" -c:v libx264 output.mp4
```

### SDK — full recording session

```ts
import { RecordingSession } from "@deus/screen-studio";

const session = new RecordingSession({
  sourceSize: { width: 1920, height: 1080 },
  outputSize: { width: 1920, height: 1080 },
  elementResolver: async (ref) => queryBrowserForRect(ref),
});

session.start();

// Feed MCP tool events directly
await session.handleToolEvent({
  method: "browserClick",
  requestId: "r1",
  params: { ref: "@e5" },
});

// Real-time render loop
const { camera, instructions } = session.tick();

// Or generate full timeline for encoding
const timeline = session.renderTimeline(30);
```

### CLI — record from shell

```bash
# Start a session
SESSION=$(screen-studio start --device-frame browser-chrome | jq -r .session_id)

# Log agent actions
screen-studio chapter $SESSION --title "Navigate to dashboard"
screen-studio event $SESSION --type navigate --x 960 --y 540 --url "https://app.example.com"
screen-studio event $SESSION --type click --x 500 --y 300
screen-studio event $SESSION --type type --x 500 --y 320 --text "hello"
screen-studio chapter $SESSION --title "Search results"
screen-studio event $SESSION --type scroll --x 960 --y 540 --direction down

# Check status
screen-studio status $SESSION

# Stop and get output path
screen-studio stop $SESSION
# → { "output_path": "/tmp/recording-rec_abc123.mp4", ... }
```

### MCP Server — any AI agent

Add to your MCP config:

```json
{
  "mcpServers": {
    "screen-studio": {
      "command": "node",
      "args": ["node_modules/@deus/screen-studio/dist/mcp/index.js"]
    }
  }
}
```

The agent gets 5 tools:

| Tool | Description |
|------|-------------|
| `recording_start` | Begin a session. Configure device frame, background, resolution, capture method |
| `recording_event` | Log a browser action (click, type, scroll, navigate). Drives camera zoom/pan |
| `recording_chapter` | Mark a chapter point with a title |
| `recording_status` | Check recording state, duration, event/chapter counts |
| `recording_stop` | Stop, post-process with ffmpeg, return MP4 path |

Example agent workflow:

```
Agent: recording_start({ deviceFrame: "browser-chrome" })
→ { sessionId: "rec_a1b2c3", status: "recording" }

Agent: recording_event({ sessionId: "rec_a1b2c3", type: "click", x: 500, y: 300 })
Agent: recording_event({ sessionId: "rec_a1b2c3", type: "type", x: 500, y: 320, text: "hello" })
Agent: recording_chapter({ sessionId: "rec_a1b2c3", title: "Filled form" })

Agent: recording_stop({ sessionId: "rec_a1b2c3" })
→ { outputPath: "/tmp/recording-rec_a1b2c3.mp4", duration: 12.5, eventCount: 2, chapterCount: 1 }
```

## Camera engine

The camera engine is the core of the package. It computes smooth zoom and pan transforms from discrete agent events using spring physics.

### Spring physics

Camera position and zoom are driven by damped harmonic oscillators. The spring smoothly animates between targets with configurable stiffness (`omega`) and damping (`zeta`).

```ts
const engine = new CameraEngine({
  sourceSize: { width: 1920, height: 1080 },
  positionSpring: { omega: 8, zeta: 0.7 },  // Snappy, slightly underdamped
  zoomSpring: { omega: 6, zeta: 0.85 },      // Smooth, no overshoot
  minZoom: 1.0,
  maxZoom: 2.8,
});
```

### Dead zone

The camera only moves when the target exits a dead zone around the current viewport center. This prevents jittery micro-movements during rapid typing.

```ts
const engine = new CameraEngine({
  sourceSize: { width: 1920, height: 1080 },
  deadZone: { fraction: 0.15, hysteresis: 0.05 },
});
```

### Intent classification

Events are classified into intents (typing, clicking, scrolling, navigating) which determine zoom levels. Typing zooms in tight, navigation zooms out wide.

```ts
import { IntentClassifier, ShotPlanner } from "@deus/screen-studio";

const classifier = new IntentClassifier({ sourceSize: { width: 1920, height: 1080 } });
const intent = classifier.classify(events);
// → { type: "typing", center: { x: 500, y: 320 }, zoom: 2.0 }
```

## Compositor

The compositor is canvas-agnostic — it computes **render instructions** (source crop region, destination region, cursor position, device frame info) without touching any canvas API. This makes it testable and portable.

```ts
const compositor = new Compositor({
  output: { width: 1920, height: 1080 },
  source: { width: 1920, height: 1080 },
  deviceFrame: { type: "browser-chrome", title: "Example" },
  background: { type: "gradient", colors: ["#0f0f23", "#1a1a3e"], angle: 135 },
  cursor: { visible: true, size: 24, showClickRipple: true, rippleDuration: 400 },
});

const instructions = compositor.computeFrame(camera, cursor);
// → { source: { x, y, w, h }, content: { x, y, w, h }, cursor: {...}, deviceFrame: {...} }
```

### Canvas renderer (browser)

For browser rendering, use `CanvasRenderer`:

```ts
import { CanvasRenderer } from "@deus/screen-studio/compositor";

const renderer = new CanvasRenderer(ctx);
renderer.renderFrame(sourceImage, instructions, backgroundConfig);
```

### Device frames

| Type | Description |
|------|-------------|
| `browser-chrome` | Browser window with traffic lights, URL bar, title |
| `macos-window` | macOS window with traffic lights and title bar |
| `none` | No frame — just the content |

### Backgrounds

```ts
// Gradient
{ type: "gradient", colors: ["#0f0f23", "#1a1a3e"], angle: 135 }

// Solid color
{ type: "solid", colors: ["#1a1a2e"] }

// Blurred content (frosted glass)
{ type: "blur", blurRadius: 20 }
```

## Video encoding

Two ffmpeg filter strategies:

### `generateCropScaleFilter` (recommended)

Crops and scales each frame. Fast, works with any resolution.

```ts
const filter = generateCropScaleFilter(timeline, sourceSize, outputSize);
// → "crop=960:540:480:270,scale=1920:1080" (changes per segment)
```

### `generateFfmpegFilter`

Uses ffmpeg's `zoompan` filter for continuous zoom. Slower but smoother for long recordings.

```ts
const filter = generateFfmpegFilter(timeline, sourceSize, outputSize);
// → "zoompan=z='if(between(on,0,3),1.00,...'" (per-frame expressions)
```

## Frame capture

### SDK frame source interfaces

The SDK defines abstract `FrameSource` interfaces for embedding in your own app. Implementations are platform-specific:

| Source | Platform | How |
|--------|----------|-----|
| CDP screencast | Electron | `Page.startScreencast` via BrowserView debugger |
| VNC canvas | Cloud VMs | noVNC `canvas.captureStream()` |
| Screenshot polling | Fallback | `webContents.capturePage()` at interval |

### Built-in ffmpeg capture (CLI / MCP)

The CLI and MCP server ship a built-in ffmpeg-based recorder (`src/mcp/ffmpeg-recorder.ts`) that handles screen capture directly:

| Capture method | Platform | How |
|----------------|----------|-----|
| `x11grab` | Linux | `ffmpeg -f x11grab` from Xvfb (no permissions needed) |
| `avfoundation` | macOS | `ffmpeg -f avfoundation` (requires Screen Recording permission) |
| `none` | Any | Events-only mode — no capture, post-process later |

## Agent event types

| Type | Camera behavior | Example |
|------|----------------|---------|
| `click` | Zoom in to element | User clicks a button |
| `type` | Zoom tight to input | User types in a field |
| `scroll` | Gentle pan | User scrolls page |
| `navigate` | Zoom out to full view | User navigates to new URL |
| `screenshot` | Brief hold | Agent takes a screenshot |
| `idle` | Slow zoom out | No activity |

## CLI reference

```
screen-studio <command> [options]

Commands:
  start     Start a recording session
  event     Log a browser action event
  chapter   Add a chapter marker
  status    Get session status
  stop      Stop recording and post-process
  list      List all sessions
  help      Show help

start options:
  --output <path>          Output MP4 path (default: /tmp/recording-<id>.mp4)
  --capture <method>       x11grab | avfoundation | screenshot | none
  --display <display>      X11 display (default: :99)
  --fps <n>                Frame rate (default: 30)
  --source-width <n>       Source width (default: 1920)
  --source-height <n>      Source height (default: 1080)
  --output-width <n>       Output width (default: 1920)
  --output-height <n>      Output height (default: 1080)
  --device-frame <type>    browser-chrome | macos-window | none

event options:
  --type <type>            click | type | scroll | navigate | screenshot | idle
  --x <n>                  X coordinate in source pixels
  --y <n>                  Y coordinate in source pixels
  --text <text>            Text content (for type events)
  --url <url>              URL (for navigate events)
  --direction <dir>        up | down | left | right (for scroll events)
  --element-rect <json>    Element bounding rect as JSON

chapter options:
  --title <title>          Chapter title

stop options:
  --watermark <text>       Add watermark text to video
```

All CLI output is JSON, one object per line. Pipe to `jq` for formatting.

## Architecture

```
packages/screen-studio/
├── src/
│   ├── camera/           Spring physics, dead zone, camera engine
│   ├── intent/           Intent classification, shot planning
│   ├── compositor/       Render instructions (canvas-agnostic) + canvas renderer
│   ├── interpolation/    Catmull-Rom splines, smoothstep
│   ├── recorder/         Timeline recorder, ffmpeg filter generation
│   ├── adapter/          MCP tool event → camera event mapping
│   ├── source/           Frame source interfaces (CDP, VNC, polling)
│   ├── session/          Recording session orchestrator
│   ├── mcp/              MCP server, session manager, ffmpeg recorder
│   ├── cli/              CLI entry point
│   ├── types.ts          Core type definitions
│   └── index.ts          Public API exports
├── test/                 243 tests (vitest)
├── demo/                 Interactive browser demo
└── dist/                 Built output (ESM + CJS + DTS)
```

## Testing

```bash
# Run all tests
bun run test:screen-studio

# Or from the package directory
cd packages/screen-studio && bunx vitest run

# Watch mode
bunx vitest
```

## Demo

```bash
cd packages/screen-studio
bunx serve . -p 3456
# Open http://localhost:3456/demo/
```

The demo shows the camera engine and compositor running in real-time. Click on the source canvas to simulate agent events and watch the camera zoom/pan in the output canvas.

## Cross-platform

The core engine is pure math — runs anywhere JavaScript runs (browser, Node.js, Bun, Deno).

| Component | Browser | Node.js | Linux | macOS |
|-----------|---------|---------|-------|-------|
| Camera engine | Yes | Yes | Yes | Yes |
| Compositor | Yes | Yes | Yes | Yes |
| Canvas renderer | Yes | With `canvas` npm | With `canvas` npm | With `canvas` npm |
| ffmpeg capture | — | x11grab | x11grab | avfoundation |
| MCP server | — | Yes | Yes | Yes |
| CLI | — | Yes | Yes | Yes |
