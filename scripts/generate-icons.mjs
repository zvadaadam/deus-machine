#!/usr/bin/env node
/**
 * Generate brand assets from a single SVG source of truth.
 *
 * Run rarely — when the brand or accent changes:
 *   bun run icons
 *
 * Outputs:
 *   resources/icons/{master-1024,icon,icon-dev,icon-tray}.png + icon.icns
 *   apps/web/public/{favicon{,-16x16,-32x32}.png, apple-touch-icon.png,
 *                    og-image.png, icon.svg}
 *
 * macOS-only: .icns generation needs `iconutil`. On other platforms the
 * .icns step is skipped (it's pre-generated and committed).
 */

import sharp from "sharp";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ICONS = join(ROOT, "resources/icons");
const WEB = join(ROOT, "apps/web/public");

const BG = "#0f0f0f";
const ACCENT = "#d4a0b8"; // oklch(0.78 0.09 345) ≈ cool rose
const DEV_ACCENT = "#F59E0B"; // amber — visually distinct dev variant

// macOS squircle on a 1024×1024 canvas. Inner shape spans 100..920 (824px),
// leaving a 100px safe-area for the soft drop shadow. macOS does NOT auto-mask
// app icons — squircle and shadow are baked into the master.
const SQUIRCLE =
  "M 512 100 C 720 100 820 100 870 150 C 920 200 920 300 920 512 " +
  "C 920 720 920 820 870 870 C 820 920 720 920 512 920 " +
  "C 300 920 200 920 150 870 C 100 820 100 720 100 512 " +
  "C 100 300 100 200 150 150 C 200 100 300 100 512 100 Z";

const SHADOW = `<filter id="d" x="-15%" y="-15%" width="130%" height="130%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
  <feOffset dy="10"/>
  <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
  <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>`;

const appSvg = (accent) => `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
  <defs>${SHADOW}</defs>
  <g filter="url(#d)">
    <path d="${SQUIRCLE}" fill="${BG}"/>
    <circle cx="512" cy="512" r="180" fill="${accent}"/>
  </g>
</svg>`;

const renderSvg = (svg, path) =>
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path);

const resize = (src, size, path) =>
  sharp(src)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(path);

async function buildIcns(master) {
  if (process.platform !== "darwin") {
    console.warn("Skipping icon.icns — needs macOS iconutil");
    return;
  }
  const set = join(ICONS, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    await resize(master, s, join(set, `icon_${s}x${s}.png`));
    await resize(master, s * 2, join(set, `icon_${s}x${s}@2x.png`));
  }
  execSync(`iconutil -c icns "${set}" -o "${join(ICONS, "icon.icns")}"`);
  rmSync(set, { recursive: true });
}

async function main() {
  const master = join(ICONS, "master-1024.png");

  // Source of truth — squircle + rose accent
  await renderSvg(appSvg(ACCENT), master);

  // Dev variant — render at 1024 then downscale to 512 so the shadow stays sharp
  await sharp(Buffer.from(appSvg(DEV_ACCENT)))
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(join(ICONS, "icon-dev.png"));

  // Win/Linux package + Linux BrowserWindow icon
  await resize(master, 512, join(ICONS, "icon.png"));

  // Tray glyph — monochrome alpha for macOS template image
  await renderSvg(
    `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="22" fill="#fff"/></svg>`,
    join(ICONS, "icon-tray.png")
  );

  // Web favicons (all derived from master)
  for (const [name, size] of [
    ["favicon.png", 32],
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
  ]) {
    await resize(master, size, join(WEB, name));
  }

  // OG social card — different aspect ratio, rendered at native size
  await renderSvg(
    `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="630" fill="${BG}"/><circle cx="600" cy="315" r="100" fill="${ACCENT}"/></svg>`,
    join(WEB, "og-image.png")
  );

  // Inline SVG favicon — scalable, browser-tab friendly
  writeFileSync(
    join(WEB, "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${BG}"/><circle cx="16" cy="16" r="5.75" fill="${ACCENT}"/></svg>`
  );

  await buildIcns(master);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
