/**
 * The desktop's IPC surface, held together from the source text:
 *
 * - every channel the preload reaches (a named method or the generic bridge's
 *   allowlists) has a handler (`ipcMain.handle`) or an emitter
 *   (`webContents.send`) in the main process, and every handler is reachable
 *   from the preload;
 * - every named method is called by the web app, every allowlisted channel is
 *   named by the web app, unless it is in KEPT_ON_PURPOSE with a reason.
 *
 * A channel declared and used nowhere fails here: delete it from both sides.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Named preload methods or allowlisted channels that nothing calls yet, and why they stay. */
const KEPT_ON_PURPOSE: Record<string, string> = {};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const preload = read("apps/desktop/preload/index.ts");

function setEntries(name: string): string[] {
  const body = preload.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!body) throw new Error(`${name} not found in the preload`);
  return [...body[1].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
}

/** The electronAPI object's methods, each with the channels it invokes or listens on. */
function namedMethods(): Map<string, { invoke: string[]; on: string[] }> {
  const body = preload.match(/const electronAPI = \{([\s\S]*?)\n\};/);
  if (!body) throw new Error("electronAPI not found in the preload");
  const methods = new Map<string, { invoke: string[]; on: string[] }>();
  // Methods are the object's own keys: two-space indent.
  const parts = body[1].split(/\n {2}(?=\w+: )/);
  for (const part of parts.slice(1)) {
    const name = part.match(/^(\w+):/)![1];
    methods.set(name, {
      invoke: [...part.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]),
      on: [...part.matchAll(/ipcRenderer\.on\(\s*"([^"]+)"/g)].map((m) => m[1]),
    });
  }
  return methods;
}

const mainSource = filesUnder("apps/desktop/main")
  .map((file) => read(file))
  .join("\n");
const handled = new Set(
  [...mainSource.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1])
);
const emitted = new Set([...mainSource.matchAll(/\.send\(\s*"([^"]+)"/g)].map((m) => m[1]));

// The web app's sources, without the bridge's type declaration (a type is not a use).
const webFiles = filesUnder("apps/web/src").filter((f) => !f.endsWith("env.d.ts"));
const webSources = webFiles.map((file) => read(file));
// Event names the web app listens to are constants in shared/events.ts.
const channelCorpus = [...webSources, read("shared/events.ts")].join("\n");
/** Methods the web app calls on window.electronAPI, directly or through a local alias of it. */
function calledMethods(): Set<string> {
  const called = new Set<string>();
  for (const source of webSources) {
    for (const m of source.matchAll(/electronAPI[!?]?\s*\.\s*(\w+)/g)) called.add(m[1]);
    for (const alias of source.matchAll(/const (\w+) = window\.electronAPI\b/g)) {
      for (const m of source.matchAll(new RegExp(`\\b${alias[1]}\\s*\\.\\s*(\\w+)`, "g"))) {
        called.add(m[1]);
      }
    }
  }
  return called;
}
const called = calledMethods();

const invokeAllowlist = setEntries("ALLOWED_INVOKE_CHANNELS");
const eventAllowlist = setEntries("ALLOWED_EVENT_CHANNELS");
const methods = namedMethods();

describe("desktop IPC surface", () => {
  it("parses the preload", () => {
    expect(invokeAllowlist.length).toBeGreaterThan(5);
    expect(eventAllowlist.length).toBeGreaterThan(0);
    expect(methods.size).toBeGreaterThan(5);
    expect(methods.has("invoke") && methods.has("on")).toBe(true);
  });

  it("has a main-process handler for every channel the preload invokes", () => {
    const invoked = [...invokeAllowlist, ...[...methods.values()].flatMap((m) => m.invoke)];
    expect(invoked.filter((channel) => !handled.has(channel))).toEqual([]);
  });

  it("has a main-process emitter for every event the preload listens to", () => {
    const listened = [...eventAllowlist, ...[...methods.values()].flatMap((m) => m.on)];
    expect(listened.filter((channel) => !emitted.has(channel))).toEqual([]);
  });

  it("reaches every main-process handler from the preload", () => {
    const reachable = new Set([
      ...invokeAllowlist,
      ...[...methods.values()].flatMap((m) => m.invoke),
    ]);
    expect([...handled].filter((channel) => !reachable.has(channel))).toEqual([]);
  });

  it("uses every named method in the web app", () => {
    const unused = [...methods.keys()].filter(
      (name) => !(name in KEPT_ON_PURPOSE) && !called.has(name)
    );
    expect(unused).toEqual([]);
  });

  it("names every allowlisted channel in the web app", () => {
    const unused = [...invokeAllowlist, ...eventAllowlist].filter(
      (channel) => !(channel in KEPT_ON_PURPOSE) && !channelCorpus.includes(`"${channel}"`)
    );
    expect(unused).toEqual([]);
  });

  it("keeps nothing on purpose that the preload no longer declares", () => {
    const declared = new Set([...methods.keys(), ...invokeAllowlist, ...eventAllowlist]);
    expect(Object.keys(KEPT_ON_PURPOSE).filter((name) => !declared.has(name))).toEqual([]);
  });
});
