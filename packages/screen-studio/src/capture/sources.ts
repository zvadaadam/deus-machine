import { ScreenStudioError } from "../errors.js";
import { run, tail } from "../util/process.js";
import { parseSize } from "../util/units.js";
import type { CaptureBackend } from "./backend.js";
import { browserStreamBackend, type BrowserStreamSourceSpec } from "./browser-stream.js";
import { browserBackend, listCdpTargets, type BrowserSourceSpec } from "./cdp.js";
import {
  displayBackend,
  listDisplays,
  testPatternBackend,
  type DisplaySourceSpec,
  type TestPatternSourceSpec,
} from "./ffmpeg-source.js";
import { listSimulators, simulatorBackend, type SimulatorSourceSpec } from "./simulator.js";

/** Resolve the tab an agent-browser session is driving, then capture it over CDP. */
export interface AgentBrowserSourceSpec {
  kind: "agent-browser";
  session: string;
  namespace?: string;
  /** agent-browser executable. Default: $AGENT_BROWSER_BIN or `agent-browser`. */
  bin?: string;
}

export type SourceSpec =
  | BrowserSourceSpec
  | BrowserStreamSourceSpec
  | AgentBrowserSourceSpec
  | SimulatorSourceSpec
  | DisplaySourceSpec
  | TestPatternSourceSpec;

export const SOURCE_ID_EXAMPLES = [
  "browser:http://127.0.0.1:9222",
  "browser:ws://127.0.0.1:9222/devtools/page/<target-id>",
  "browser-stream:ws://127.0.0.1:<port>  (a frame stream another component runs)",
  "agent-browser:<session>  (or agent-browser:<namespace>/<session>)",
  "ios-simulator:booted  (or ios-simulator:<udid>)",
  "display:0",
  "test-pattern:1280x720",
];

/** Parse a source ID such as `ios-simulator:booted` into a spec. */
export function parseSourceId(id: string): SourceSpec {
  const colon = id.indexOf(":");
  const scheme = (colon < 0 ? id : id.slice(0, colon)).trim();
  const rest = colon < 0 ? "" : id.slice(colon + 1).trim();
  switch (scheme) {
    case "browser":
    case "cdp":
      if (!rest) break;
      return { kind: "browser", endpoint: rest };
    case "browser-stream":
      if (!rest) break;
      return { kind: "browser-stream", url: rest };
    case "agent-browser": {
      const [namespace, session] = rest.includes("/") ? rest.split("/", 2) : [undefined, rest];
      return {
        kind: "agent-browser",
        session: session || "default",
        ...(namespace ? { namespace } : {}),
      };
    }
    case "ios-simulator":
    case "simulator":
      return { kind: "ios-simulator", udid: rest || "booted" };
    case "display": {
      const screen = rest ? Number(rest) : 0;
      if (!Number.isInteger(screen) || screen < 0) break;
      return { kind: "display", screen };
    }
    case "test-pattern":
      return {
        kind: "test-pattern",
        ...(rest ? { size: parseSize(rest, "test pattern size") } : {}),
      };
  }
  throw new ScreenStudioError("invalid_argument", `Unknown source "${id}"`, {
    hint: `Run \`screen-studio sources\`, or use one of: ${SOURCE_ID_EXAMPLES.join(" | ")}`,
  });
}

export async function resolveSource(source: string | SourceSpec): Promise<CaptureBackend> {
  const spec = typeof source === "string" ? parseSourceId(source) : source;
  switch (spec.kind) {
    case "browser":
      return browserBackend(spec);
    case "browser-stream":
      return browserStreamBackend(spec);
    case "agent-browser":
      return agentBrowserBackend(spec);
    case "ios-simulator":
      return simulatorBackend(spec);
    case "display":
      return displayBackend(spec);
    case "test-pattern":
      return testPatternBackend(spec);
  }
}

async function agentBrowser(
  spec: AgentBrowserSourceSpec,
  args: string[]
): Promise<Record<string, unknown>> {
  const bin = spec.bin ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
  const env = {
    ...process.env,
    ...(spec.namespace ? { AGENT_BROWSER_NAMESPACE: spec.namespace } : {}),
  };
  const result = await run(bin, ["--session", spec.session, ...args, "--json"], {
    env,
    timeoutMs: 30_000,
  });
  const line = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  const parsed = line
    ? (JSON.parse(line) as { success?: boolean; data?: Record<string, unknown>; error?: string })
    : null;
  if (result.code !== 0 || !parsed || parsed.success === false) {
    throw new ScreenStudioError(
      "source_unavailable",
      `agent-browser session "${spec.session}" did not answer: ${parsed?.error ?? tail(result.stderr || result.stdout)}`,
      { hint: "Open a page in that session first, e.g. agent-browser --session <name> open <url>" }
    );
  }
  return parsed.data ?? {};
}

async function agentBrowserBackend(spec: AgentBrowserSourceSpec): Promise<CaptureBackend> {
  const cdp = await agentBrowser(spec, ["get", "cdp-url"]);
  const endpoint = typeof cdp.cdpUrl === "string" ? cdp.cdpUrl : undefined;
  if (!endpoint)
    throw new ScreenStudioError("source_unavailable", "agent-browser returned no CDP URL");
  const page = await agentBrowser(spec, ["get", "url"]).catch(
    () => ({}) as Record<string, unknown>
  );
  const url = typeof page.url === "string" && page.url ? page.url : undefined;
  const label = `agent-browser ${spec.namespace ? `${spec.namespace}/` : ""}${spec.session}`;
  // When the session already streams its viewport (a live viewer), join that
  // stream rather than make the browser encode a second screencast.
  const stream = await agentBrowser(spec, ["stream", "status"]).catch(() => null);
  const backend =
    stream?.enabled === true && typeof stream.port === "number"
      ? await browserStreamBackend(
          {
            kind: "browser-stream",
            url: `ws://127.0.0.1:${stream.port}`,
            cdp: endpoint,
            ...(url ? { urlContains: url } : {}),
          },
          label
        )
      : await browserBackend(
          { kind: "browser", endpoint, ...(url ? { urlContains: url } : {}) },
          label
        );
  return {
    ...backend,
    details: { ...backend.details, agentBrowserSession: spec.session, namespace: spec.namespace },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface SourceInfo {
  id: string;
  kind: string;
  label: string;
  ready: boolean;
  notes?: string[];
}

export async function listSources(
  options: { cdp?: string[]; deviceSet?: string } = {}
): Promise<{ sources: SourceInfo[]; problems: string[] }> {
  const sources: SourceInfo[] = [];
  const problems: string[] = [];
  const explicitCdp = options.cdp ?? process.env.SCREEN_STUDIO_CDP?.split(",").filter(Boolean);
  const endpoints = explicitCdp?.length ? explicitCdp : ["http://127.0.0.1:9222"];

  await Promise.all([
    ...endpoints.map(async (endpoint) => {
      try {
        for (const target of await listCdpTargets(endpoint)) {
          if (target.type !== "page") continue;
          sources.push({
            id: `browser:${target.webSocketDebuggerUrl}`,
            kind: "browser",
            label: target.title ? `${target.title} — ${target.url}` : target.url,
            ready: true,
          });
        }
      } catch (err) {
        if (explicitCdp?.length) problems.push(`${endpoint}: ${(err as Error).message}`);
      }
    }),
    (async () => {
      try {
        for (const device of await listSimulators(options.deviceSet)) {
          if (device.state !== "Booted") continue;
          sources.push({
            id: `ios-simulator:${device.udid}`,
            kind: "ios-simulator",
            label: `${device.name} (${device.runtime})`,
            ready: true,
          });
        }
      } catch (err) {
        if (process.platform === "darwin")
          problems.push(`iOS Simulator: ${(err as Error).message}`);
      }
    })(),
    (async () => {
      try {
        for (const display of await listDisplays()) {
          sources.push({
            id: `display:${display.screen}`,
            kind: "display",
            label: display.name,
            ready: true,
            notes: ["Requires Screen Recording permission for the app running this command"],
          });
        }
      } catch (err) {
        problems.push(`Displays: ${(err as Error).message}`);
      }
    })(),
  ]);

  sources.push({
    id: "agent-browser:<session>",
    kind: "agent-browser",
    label: "The tab an agent-browser session is driving (resolved at start)",
    ready: true,
  });
  sources.push({
    id: "test-pattern:1280x720",
    kind: "test-pattern",
    label: "Synthetic test pattern",
    ready: true,
  });
  return { sources, problems };
}
