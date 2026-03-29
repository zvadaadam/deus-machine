#!/usr/bin/env node
/**
 * generate-icons.mjs — Generate all app icons from a master 1024x1024 PNG.
 *
 * Usage:
 *   node scripts/generate-icons.mjs                          # generate master + all sizes
 *   node scripts/generate-icons.mjs --master-only             # only generate master icon
 *   node scripts/generate-icons.mjs --from resources/icons/master.png  # use existing master
 *
 * Requires: sharp (already in project deps via agent-sdk)
 * macOS only: uses `iconutil` for .icns and `sips` as fallback
 */

import sharp from "sharp";
import { execSync } from "child_process";
import { mkdirSync, existsSync, rmSync, copyFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const ICONS_DIR = join(ROOT, "resources", "icons");
const WEB_PUBLIC = join(ROOT, "apps", "web", "public");
const MASTER_PATH = join(ICONS_DIR, "master-1024.png");

// ─── Project colors ───────────────────────────────────────────────
// From global.css dark theme
const BG_COLOR = "#0f0f0f"; // slightly lifted from #0b0b0b for icon visibility
const ACCENT_COLOR = "#d4a0b8"; // oklch(0.78 0.09 345) ≈ cool rose

// ─── Icon sizes config ────────────────────────────────────────────
const ELECTRON_SIZES = [
  { name: "16x16.png", size: 16 },
  { name: "24x24.png", size: 24 },
  { name: "32x32.png", size: 32 },
  { name: "48x48.png", size: 48 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "256x256.png", size: 256 },
  { name: "512x512.png", size: 512 },
  { name: "icon.png", size: 512 },
];

// macOS .icns requires these exact sizes in an .iconset folder
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

const TRAY_SIZES = [
  { name: "tray-icon.png", size: 18 },
  { name: "tray-icon@2x.png", size: 36 },
];

// ─── Generate master icon ─────────────────────────────────────────
async function generateMaster() {
  console.log("Generating master 1024x1024 icon...");

  const size = 1024;
  const circleRadius = Math.round(size * 0.18); // ~184px radius
  const cx = size / 2;
  const cy = size / 2;

  // SVG with background + accent circle
  // No rounded corners — macOS applies squircle mask automatically,
  // Windows/Linux expect square icons
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${BG_COLOR}" />
      <circle cx="${cx}" cy="${cy}" r="${circleRadius}" fill="${ACCENT_COLOR}" />
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(MASTER_PATH);

  console.log(`  -> ${MASTER_PATH}`);
  return MASTER_PATH;
}

// ─── Generate dev icon (orange dot variant) ───────────────────────
async function generateDevIcon() {
  console.log("Generating dev icon (orange dot)...");
  const size = 512;
  const circleRadius = Math.round(size * 0.18);

  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${BG_COLOR}" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${circleRadius}" fill="#F59E0B" />
    </svg>
  `;

  const devPath = join(ICONS_DIR, "icon-dev.png");
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(devPath);

  console.log(`  -> ${devPath}`);
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
  // Electron / desktop icons
  console.log("\nGenerating desktop icons...");
  for (const { name, size } of ELECTRON_SIZES) {
    const out = join(ICONS_DIR, name);
    await resizeTo(masterPath, out, size);
    console.log(`  -> ${name} (${size}x${size})`);
  }

  // Tray icons
  console.log("\nGenerating tray icons...");
  for (const { name, size } of TRAY_SIZES) {
    const out = join(ICONS_DIR, name);
    await resizeTo(masterPath, out, size);
    console.log(`  -> ${name} (${size}x${size})`);
  }

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
  await sharp(Buffer.from(svgFavicon))
    .toFile(svgFaviconPath);
  // Also write the raw SVG for browsers that prefer it
  const { writeFileSync } = await import("fs");
  writeFileSync(svgFaviconPath, svgFavicon.trim());
  console.log(`  -> apps/web/public/icon.svg`);

  // Dev icon
  await generateDevIcon();
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

// ─── Generate .ico (Windows) ─────────────────────────────────────
async function generateIco(masterPath) {
  console.log("\nGenerating .ico (Windows)...");

  // .ico format: we'll create individual PNGs and note the limitation
  // A proper .ico requires a tool like png-to-ico or ImageMagick
  // For now, create the constituent PNGs; electron-builder handles .ico generation
  const icoSizes = [16, 24, 32, 48, 64, 256];
  const icoDir = join(ICONS_DIR, "ico-parts");
  if (!existsSync(icoDir)) mkdirSync(icoDir, { recursive: true });

  for (const size of icoSizes) {
    await resizeTo(masterPath, join(icoDir, `${size}.png`), size);
    console.log(`  -> ico-parts/${size}.png`);
  }

  console.log(
    "  Note: electron-builder auto-generates .ico from icon.png during build."
  );
  console.log(
    "  For a hand-crafted .ico: brew install imagemagick && magick ico-parts/*.png icon.ico"
  );
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const masterOnly = args.includes("--master-only");
  const fromArg = args.indexOf("--from");
  const customMaster =
    fromArg !== -1 ? resolve(args[fromArg + 1]) : null;

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
  await generateIco(masterPath);

  console.log("\n=== Done! ===");
  console.log("\nGenerated files:");
  console.log("  Desktop:  resources/icons/ (all sizes + .icns)");
  console.log("  Tray:     resources/icons/tray-icon*.png");
  console.log("  Web:      apps/web/public/ (favicon, apple-touch, og, svg)");
  console.log("  Dev:      resources/icons/icon-dev.png (orange dot)");
  console.log("");
  console.log("Rounded corners: NOT baked in. Reasons:");
  console.log("  - macOS auto-applies squircle mask to all app icons");
  console.log("  - Windows/Linux expect square icons");
  console.log("  - SVG favicon has rx=6 for browser tab display");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
