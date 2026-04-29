#!/usr/bin/env node
/**
 * generate-icons.mjs — Generate all app icons from a master 1024x1024 PNG.
 *
 * Usage:
 *   node scripts/generate-icons.mjs                          # generate master + all sizes
 *   node scripts/generate-icons.mjs --master-only             # only generate master icon
 *   node scripts/generate-icons.mjs --from resources/icons/master.png  # use existing master
 *
 * Requires: sharp
 * macOS only: uses `iconutil` for .icns and `sips` as fallback
 */

import sharp from "sharp";
import { execSync } from "child_process";
import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const ICONS_DIR = join(ROOT, "resources", "icons");
const WEB_PUBLIC = join(ROOT, "apps", "web", "public");
const MASTER_PATH = join(ICONS_DIR, "master-1024.png");

// ─── Project colors ───────────────────────────────────────────────
// From global.css dark theme
const BG_COLOR = "#0f0f0f"; // slightly lifted from #0b0b0b for icon visibility
const ACCENT_COLOR = "#d4a0b8"; // oklch(0.78 0.09 345) ≈ cool rose
const DEV_ACCENT = "#F59E0B"; // amber — visually distinct dev variant

// ─── Icon shape ───────────────────────────────────────────────────
// macOS squircle (continuous-curvature superellipse) on a 1024×1024 canvas.
// Inner shape spans 100..920 (824px) leaving a 100px safe-area for the soft
// drop shadow. macOS does NOT auto-mask app icons — the squircle, padding,
// and shadow must be baked into the PNG so the dock displays them directly.
const SQUIRCLE_PATH_1024 =
  "M 512 100 C 720 100 820 100 870 150 C 920 200 920 300 920 512 " +
  "C 920 720 920 820 870 870 C 820 920 720 920 512 920 " +
  "C 300 920 200 920 150 870 C 100 820 100 720 100 512 " +
  "C 100 300 100 200 150 150 C 200 100 300 100 512 100 Z";

// Drop-shadow filter — soft, slightly offset down. Baked into the master so
// every downscaled variant retains the same grounded look.
const DROP_SHADOW_FILTER = `
  <filter id="drop" x="-15%" y="-15%" width="130%" height="130%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
    <feOffset dx="0" dy="10"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
    <feMerge>
      <feMergeNode/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
`;

function buildAppIconSvg(accent) {
  return `
    <svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
      <defs>${DROP_SHADOW_FILTER}</defs>
      <g filter="url(#drop)">
        <path d="${SQUIRCLE_PATH_1024}" fill="${BG_COLOR}"/>
        <circle cx="512" cy="512" r="180" fill="${accent}"/>
      </g>
    </svg>
  `;
}

// macOS .icns requires these exact sizes in an .iconset folder.
// Intermediate — written to a tmp dir, packed into icon.icns by iconutil, deleted.
const ICONSET_SIZES = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

const WEB_SIZES = [
  { name: "favicon.png", size: 32 },
  { name: "favicon-16x16.png", size: 16 },
  { name: "favicon-32x32.png", size: 32 },
  { name: "apple-touch-icon.png", size: 180 },
];

// ─── Generate master icon ─────────────────────────────────────────
async function generateMaster() {
  console.log("Generating master 1024x1024 icon (squircle + soft shadow)...");
  const svg = buildAppIconSvg(ACCENT_COLOR);
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(MASTER_PATH);
  console.log(`  -> ${MASTER_PATH}`);
  return MASTER_PATH;
}

// ─── Generate dev icon (orange accent variant) ────────────────────
async function generateDevIcon() {
  console.log("Generating dev icon (squircle + amber accent)...");
  const svg = buildAppIconSvg(DEV_ACCENT);
  const devPath = join(ICONS_DIR, "icon-dev.png");
  // Render at 1024 then downscale to 512 so the shadow stays sharp.
  await sharp(Buffer.from(svg))
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(devPath);
  console.log(`  -> ${devPath}`);
}

// ─── Generate tray glyph ──────────────────────────────────────────
// Monochrome alpha glyph for macOS template image (Tray.setTemplateImage(true)).
// macOS tints it for light/dark menu bars; on Windows it shows as white-on-tray.
async function generateTrayIcon() {
  console.log("Generating tray glyph (monochrome, alpha-only)...");
  const svg = `
    <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="22" fill="#ffffff"/>
    </svg>
  `;
  const trayPath = join(ICONS_DIR, "icon-tray.png");
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(trayPath);
  console.log(`  -> ${trayPath}`);
}

// ─── Resize helper ────────────────────────────────────────────────
async function resizeTo(masterPath, outputPath, size) {
  await sharp(masterPath)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

// ─── Generate all sizes ──────────────────────────────────────────
async function generateAllSizes(masterPath) {
  // Single 512px icon.png — used by Windows/Linux packaging and the Linux
  // BrowserWindow icon. electron-builder generates .ico from this directly.
  console.log("\nGenerating icon.png (512x512)...");
  await resizeTo(masterPath, join(ICONS_DIR, "icon.png"), 512);

  // Web icons
  console.log("\nGenerating web icons...");
  for (const { name, size } of WEB_SIZES) {
    const out = join(WEB_PUBLIC, name);
    await resizeTo(masterPath, out, size);
    console.log(`  -> apps/web/public/${name} (${size}x${size})`);
  }

  // OG image (1200x630 — social card)
  console.log("\nGenerating OG image (1200x630)...");
  const ogSvg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="${BG_COLOR}" />
      <circle cx="600" cy="315" r="100" fill="${ACCENT_COLOR}" />
    </svg>
  `;
  const ogPath = join(WEB_PUBLIC, "og-image.png");
  await sharp(Buffer.from(ogSvg))
    .png({ compressionLevel: 9 })
    .toFile(ogPath);
  console.log(`  -> apps/web/public/og-image.png (1200x630)`);

  // SVG favicon (scalable, supports dark mode)
  console.log("\nGenerating SVG favicon...");
  const svgFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${BG_COLOR}"/>
  <circle cx="16" cy="16" r="5.75" fill="${ACCENT_COLOR}"/>
</svg>`;
  const svgFaviconPath = join(WEB_PUBLIC, "icon.svg");
  writeFileSync(svgFaviconPath, svgFavicon.trim());
  console.log(`  -> apps/web/public/icon.svg`);

  // Dev icon
  await generateDevIcon();

  // Tray glyph
  await generateTrayIcon();
}

// ─── Generate .icns (macOS) ──────────────────────────────────────
async function generateIcns(masterPath) {
  if (process.platform !== "darwin") {
    console.log("\nSkipping .icns generation (not on macOS)");
    return;
  }

  console.log("\nGenerating .icns (macOS app icon)...");
  const iconsetDir = join(ICONS_DIR, "icon.iconset");

  // Clean and create iconset directory
  if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true });
  mkdirSync(iconsetDir, { recursive: true });

  // Generate all iconset sizes
  for (const { name, size } of ICONSET_SIZES) {
    await resizeTo(masterPath, join(iconsetDir, name), size);
  }

  // Convert to .icns using macOS iconutil
  const icnsPath = join(ICONS_DIR, "icon.icns");
  try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, {
      stdio: "pipe",
    });
    console.log(`  -> icon.icns`);
  } catch (err) {
    console.error("  Failed to generate .icns:", err.message);
  }

  // Clean up iconset directory
  rmSync(iconsetDir, { recursive: true });
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const masterOnly = args.includes("--master-only");
  const fromArg = args.indexOf("--from");
  const fromValue = fromArg !== -1 ? args[fromArg + 1] : null;
  if (fromArg !== -1 && (!fromValue || fromValue.startsWith("-"))) {
    console.error("--from requires a path argument");
    process.exit(1);
  }
  const customMaster = fromValue ? resolve(fromValue) : null;

  console.log("=== Deus Icon Generator ===\n");
  console.log(`Colors: bg=${BG_COLOR}, accent=${ACCENT_COLOR}`);
  console.log(`Output: ${ICONS_DIR}`);
  console.log("");

  let masterPath;
  if (customMaster) {
    if (!existsSync(customMaster)) {
      console.error(`Master file not found: ${customMaster}`);
      process.exit(1);
    }
    masterPath = customMaster;
    console.log(`Using custom master: ${masterPath}`);
  } else {
    masterPath = await generateMaster();
  }

  if (masterOnly) {
    console.log("\n--master-only: stopping after master generation.");
    return;
  }

  await generateAllSizes(masterPath);
  await generateIcns(masterPath);

  console.log("\n=== Done! ===");
  console.log("\nGenerated files:");
  console.log("  Desktop:  resources/icons/{master-1024,icon,icon.icns,icon-dev,icon-tray}.png");
  console.log("  Web:      apps/web/public/{favicon*,apple-touch-icon,og-image,icon}.{png,svg}");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
