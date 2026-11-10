#!/usr/bin/env bun
/**
 * Regenerate shared/integrations/icons.ts: the brand marks the catalog uses,
 * in their own colours. Both sources are CC0 devDependencies read here, so the
 * app ships only the marks it draws:
 *
 *   - SVG Logos (@iconify-json/logos) for the keys in LOGOS: the full-colour logo.
 *   - Simple Icons for the rest: one path in the brand's colour.
 *
 * A colour the tile would swallow (GitHub's black on the dark tile, tldraw's
 * white on the light one) is the mark's `ink`: written as `currentColor`, with
 * `textColorIn` naming the theme where the text colour stands in for it. That
 * is decided here, by contrast against the tile's token, so the component does
 * no colour maths.
 *
 *   bun scripts/generate-integration-icons.ts
 *
 * Run it after adding an app to the catalog.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import prettier from "prettier";
import sharp from "sharp";
import * as simpleIcons from "simple-icons";
import { CATALOG } from "../shared/integrations/catalog";

const ROOT = path.join(import.meta.dir, "..");
const TARGET = path.join(ROOT, "shared", "integrations", "icons.ts");

/**
 * Icon key → its logo in SVG Logos. Listed only where that set has more than
 * Simple Icons: several colours, a compact mark where Simple Icons draws a
 * wordmark, or a brand Simple Icons no longer carries. Wide wordmarks stay out.
 *
 * `ink` names the paint that carries the shape of a many-coloured logo and may
 * vanish into a tile (the letters of "aws"). A logo of one paint needs no
 * `ink`: that paint is it.
 */
const LOGOS: Record<string, string | { icon: string; ink: string }> = {
  airtable: "airtable",
  amplitude: "amplitude-icon",
  apify: "apify-icon",
  atlassian: "atlassian",
  aws: { icon: "aws", ink: "#252f3e" },
  blender: "blender",
  brave: "brave",
  browserbase: "browserbase-icon",
  buildkite: "buildkite-icon",
  clickup: "clickup-icon",
  cloudflare: "cloudflare-icon",
  customerio: "customerio-icon",
  descript: "descript-icon",
  exa: "exa-icon",
  facebook: "facebook",
  figma: "figma",
  firebase: "firebase-icon",
  firecrawl: "firecrawl-icon",
  flydotio: "fly-icon",
  gitlab: "gitlab-icon",
  gmail: "google-gmail-2020",
  google: "google-icon",
  googleads: "google-ads",
  googleanalytics: "google-analytics",
  googlecalendar: "google-calendar-2020",
  googlechrome: "chrome",
  googledrive: "google-drive-2020",
  grafana: "grafana",
  hootsuite: "hootsuite-icon",
  huggingface: "hugging-face-icon",
  kubernetes: "kubernetes",
  launchdarkly: "launchdarkly-icon",
  linkedin: "linkedin-icon",
  lovable: "lovable-icon",
  meta: "meta-icon",
  microsoft: "microsoft-icon",
  microsoftteams: "microsoft-teams",
  miro: "miro-icon",
  monday: "monday-icon",
  neon: "neon-icon",
  notion: "notion-icon",
  paypal: "paypal",
  playwright: "playwright",
  posthog: { icon: "posthog-icon", ink: "#000000" },
  postman: "postman-icon",
  reddit: "reddit-icon",
  redis: "redis",
  runway: "runway-icon",
  shopify: "shopify",
  slack: "slack-icon",
  snyk: "snyk",
  supabase: "supabase-icon",
  tavily: "tavily",
  todoist: "todoist-icon",
  typeform: "typeform-icon",
  youtube: "youtube-icon",
  zapier: "zapier-icon",
  zoom: "zoom-icon",
};

interface Mark {
  viewBox: string;
  body: string;
  ink?: string;
  textColorIn?: Theme;
}

// ── The tile, and what reads on it ──────────────────────────────────────

type Theme = "light" | "dark";

/**
 * The least contrast with the tile (WCAG ratio) a colour needs to read as a
 * mark, set by eye on both tiles. Colour on white stays legible at a lower
 * ratio than colour on near-black, where dark purples sink first: Datadog's
 * (2.0) is lost on the dark tile, Exa's blue (2.3) is not.
 */
const THEMES: Record<Theme, { selector: string; needs: number; textColor: string }> = {
  light: { selector: ":root", needs: 1.5, textColor: "#000000" },
  dark: { selector: ".dark", needs: 2.25, textColor: "#ffffff" },
};

/**
 * A mark of which less than this share reads on a tile is not shipped. The
 * lowest that still looks right is a yellow tile around a black letter (Miro
 * on the light tile, 0.29).
 */
const LEAST_SHARE = 0.25;

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  gold: "#ffd700",
};

/** Any colour the sources write, as #rrggbb. */
function hex(value: string): string {
  const colour = value.trim().toLowerCase();
  if (NAMED[colour]) return NAMED[colour];
  if (/^#[0-9a-f]{3}$/.test(colour)) return `#${[...colour.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{6}$/.test(colour)) return colour;
  throw new Error(`Cannot read the colour "${value}"`);
}

/** WCAG relative luminance of [red, green, blue], each 0–255. */
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const channels = (colour: string) => [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The tile is `bg-bg-elevated`: read each theme's value from the app's tokens. */
const css = readFileSync(path.join(ROOT, "apps", "web", "src", "global.css"), "utf8");
function tileOf(theme: Theme): number[] {
  const { selector } = THEMES[theme];
  const block = new RegExp(
    `^${selector.replace(".", "\\.")} \\{[^}]*?--bg-elevated:\\s*(#[0-9a-fA-F]{6});`,
    "m"
  );
  const value = css.match(block)?.[1];
  if (!value) throw new Error(`No hex --bg-elevated in the ${selector} block of global.css`);
  return channels(hex(value));
}
const TILE: Record<Theme, number[]> = { light: tileOf("light"), dark: tileOf("dark") };

const reads = (rgb: number[], theme: Theme) =>
  contrast(luminance(rgb), luminance(TILE[theme])) >= THEMES[theme].needs;

/** The theme whose tile swallows this colour, if one does. */
function swallowedIn(ink: string): Theme | undefined {
  const lost = (["light", "dark"] as const).filter((theme) => !reads(channels(ink), theme));
  if (lost.length > 1) throw new Error(`${ink} reads on neither tile`);
  return lost[0];
}

/** How much of the drawn mark reads on a theme's tile (0–1), by rasterising it. */
async function shareThatReads(mark: Mark, theme: Theme): Promise<number> {
  const size = 64;
  const colour = mark.textColorIn === theme ? THEMES[theme].textColor : (mark.ink ?? "#000000");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" width="${size}" height="${size}" color="${colour}">${mark.body}</svg>`;
  const pixels = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  let drawn = 0;
  let read = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]! / 255;
    if (alpha === 0) continue;
    const onTile = [0, 1, 2].map((c) => pixels[i + c]! * alpha + TILE[theme][c]! * (1 - alpha));
    drawn += alpha;
    if (reads(onTile, theme)) read += alpha;
  }
  return drawn === 0 ? 0 : read / drawn;
}

// ── SVG Logos: a full-colour body ───────────────────────────────────────

interface LogoSet {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
}
const logos = JSON.parse(
  readFileSync(path.join(ROOT, "node_modules", "@iconify-json", "logos", "icons.json"), "utf8")
) as LogoSet;

/** Prefix of every id in a generated body; the component swaps it per drawn copy. */
const ID = "__id__";

const TAG = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
const DRAWN = new Set(["path", "circle", "ellipse", "rect", "polygon", "polyline", "line", "use"]);
const ALLOWED = new Set([
  ...DRAWN,
  "g",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "mask",
  "clipPath",
]);

/** The body is set as markup, so it may hold shapes and paints and nothing else. */
function assertInert(name: string, body: string): void {
  for (const [, , tag, attributes] of body.matchAll(TAG)) {
    if (!ALLOWED.has(tag!)) throw new Error(`${name}: <${tag}> is not a shape or a paint`);
    for (const [, attribute, value] of attributes!.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
      const linksOut = attribute!.endsWith("href") && !value!.startsWith("#");
      const loads = /url\((?!#)|javascript:|data:/i.test(value!);
      if (/^on|^style$/i.test(attribute!) || linksOut || loads) {
        throw new Error(`${name}: ${attribute}="${value}" is not allowed in a mark`);
      }
    }
  }
  if (body.replace(TAG, "").trim()) throw new Error(`${name}: text outside elements`);
}

/** Rename every id (gradients, masks, clips) to the shared prefix and a number. */
function prefixIds(name: string, body: string): string {
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
  let out = body;
  ids.forEach((id, n) => {
    out = out
      .replaceAll(`id="${id}"`, `id="${ID}${n}"`)
      .replaceAll(`url(#${id})`, `url(#${ID}${n})`)
      .replaceAll(`href="#${id}"`, `href="#${ID}${n}"`);
  });
  for (const [, target] of out.matchAll(/(?:url\(|href=")#([^)"]+)/g)) {
    if (!target!.startsWith(ID)) throw new Error(`${name}: #${target} points at no id`);
  }
  return out;
}

/**
 * The flat paints a body draws with. A shape with no `fill` of its own or its
 * groups is black, SVG's default. What sits in a mask or a clip is not paint.
 */
function paintsOf(body: string): { flat: Set<string>; byDefault: boolean; gradients: boolean } {
  const flat = new Set<string>();
  let byDefault = false;
  let gradients = false;
  const open: Array<{ filled: boolean; unseen: boolean; inDefs: boolean }> = [];
  for (const [, closing, tag, attributes, selfClosing] of body.matchAll(TAG)) {
    if (closing) {
      open.pop();
      continue;
    }
    const parent = open.at(-1);
    const unseen = parent?.unseen || tag === "mask" || tag === "clipPath";
    const inDefs = parent?.inDefs || tag === "defs";
    let filled = parent?.filled ?? false;
    for (const [, property, value] of attributes!.matchAll(/\b(fill|stroke)="([^"]+)"/g)) {
      if (property === "fill") filled = true;
      if (unseen || value === "none") continue;
      if (value!.startsWith("url(")) gradients = true;
      else flat.add(hex(value!));
    }
    if (DRAWN.has(tag!) && !filled && !unseen && !inDefs) byDefault = true;
    if (!selfClosing) open.push({ filled, unseen, inDefs });
  }
  if (byDefault) flat.add("#000000");
  return { flat, byDefault, gradients };
}

function fromLogos(key: string): Mark {
  const spec = LOGOS[key]!;
  const name = typeof spec === "string" ? spec : spec.icon;
  const icon = logos.icons[name];
  if (!icon) throw new Error(`SVG Logos has no "${name}" (for ${key})`);
  assertInert(name, icon.body);

  const viewBox = `0 0 ${icon.width ?? logos.width ?? 256} ${icon.height ?? logos.height ?? 256}`;
  let body = prefixIds(name, icon.body);
  const { flat, byDefault, gradients } = paintsOf(body);
  const onePaint = !gradients && flat.size === 1 ? [...flat][0] : undefined;
  const ink = typeof spec === "string" ? onePaint : hex(spec.ink);
  if (!ink) return { viewBox, body };

  if (!flat.has(ink)) throw new Error(`${name} draws nothing in ${ink}`);
  if (body.includes("<mask")) throw new Error(`${name}: ink in a masked logo is not supported`);
  body = body.replace(/\b(fill|stroke)="([^"]+)"/g, (attribute, property: string, value: string) =>
    value !== "none" && !value.startsWith("url(") && hex(value) === ink
      ? `${property}="currentColor"`
      : attribute
  );
  if (ink === "#000000" && byDefault) body = `<g fill="currentColor">${body}</g>`;
  return { viewBox, body, ink, textColorIn: swallowedIn(ink) };
}

// ── Simple Icons: one path in the brand's colour ────────────────────────

interface SimpleIcon {
  slug: string;
  path: string;
  hex: string;
}

const simpleBySlug = new Map<string, SimpleIcon>();
for (const value of Object.values(simpleIcons)) {
  const icon = value as Partial<SimpleIcon>;
  if (icon && typeof icon.slug === "string" && typeof icon.path === "string") {
    simpleBySlug.set(icon.slug, icon as SimpleIcon);
  }
}

function fromSimpleIcons(key: string): Mark | undefined {
  const icon = simpleBySlug.get(key);
  if (!icon) return undefined;
  const ink = hex(`#${icon.hex}`);
  return {
    viewBox: "0 0 24 24",
    body: `<path fill="currentColor" d="${icon.path}"/>`,
    ink,
    textColorIn: swallowedIn(ink),
  };
}

// ── The catalog's marks ─────────────────────────────────────────────────

const wanted = new Set<string>();
for (const app of CATALOG.apps) if (app.icon) wanted.add(app.icon);

const marks: Array<[string, Mark]> = [];
const missing: string[] = [];
const count = { logos: 0, simple: 0 };
const inTextColor: Record<Theme, string[]> = { light: [], dark: [] };

for (const key of [...wanted].sort()) {
  const mark = LOGOS[key] ? fromLogos(key) : fromSimpleIcons(key);
  if (!mark) {
    missing.push(key);
    continue;
  }
  for (const theme of ["light", "dark"] as const) {
    const share = await shareThatReads(mark, theme);
    if (share < LEAST_SHARE) {
      throw new Error(
        `${key}: only ${Math.round(share * 100)}% of the mark reads on the ${theme} tile. ` +
          `Give it an ink in LOGOS, take another logo, or drop it for Simple Icons.`
      );
    }
  }
  if (mark.textColorIn) inTextColor[mark.textColorIn].push(key);
  count[LOGOS[key] ? "logos" : "simple"] += 1;
  marks.push([key, mark]);
}

const unused = Object.keys(LOGOS).filter((key) => !wanted.has(key));
if (unused.length) console.warn(`LOGOS names keys the catalog does not use: ${unused.join(", ")}`);

const source = `// GENERATED by scripts/generate-integration-icons.ts — do not edit by hand.
// Brand marks in their own colours: full-colour logos from SVG Logos
// (https://github.com/gilbarbara/logos, CC0 1.0), the rest one path each from
// Simple Icons (https://simpleicons.org, CC0 1.0) in the brand's colour.

export interface IntegrationIcon {
  /** The mark's own box. */
  viewBox: string;
  /**
   * SVG markup in the brand's colours. Every id starts with
   * INTEGRATION_ICON_ID; \`currentColor\` is the mark's \`ink\`.
   */
  body: string;
  /** The brand colour \`currentColor\` stands for in \`body\`. */
  ink?: string;
  /** The theme whose tile swallows \`ink\`: there the text colour is drawn instead. */
  textColorIn?: "light" | "dark";
}

/**
 * The prefix of every id in a body (gradients, masks). A page draws the same
 * mark many times, so each drawn copy replaces it with a prefix of its own.
 */
export const INTEGRATION_ICON_ID = ${JSON.stringify(ID)};

export const INTEGRATION_ICONS: Record<string, IntegrationIcon> = ${JSON.stringify(Object.fromEntries(marks))};
`;

const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(TARGET)),
  filepath: TARGET,
});
writeFileSync(TARGET, formatted);

console.log(
  `Wrote ${marks.length} marks (${count.logos} from SVG Logos, ${count.simple} from Simple Icons), ` +
    `${Buffer.byteLength(formatted)} bytes, to ${path.relative(process.cwd(), TARGET)}`
);
for (const theme of ["dark", "light"] as const) {
  if (inTextColor[theme].length) {
    console.log(`Text colour on the ${theme} tile: ${inTextColor[theme].join(", ")}`);
  }
}
if (missing.length) {
  console.warn(`No mark for: ${missing.join(", ")} (these render as initials)`);
}
