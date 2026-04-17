/**
 * prepare-device-chrome.mjs — Extract device frame assets from local Xcode/DeviceKit.
 *
 * Scans the local macOS DeviceKit installation for device chrome bundles and
 * simulator device type profiles. Converts PDF frame assets to web-friendly
 * SVG/WebP and generates a manifest.json for the DeviceFrame component.
 *
 * Output: apps/web/public/device-chrome/
 *   ├── manifest.json           — deviceType → { chromeId, asset, screen area }
 *   ├── phone7.svg ... phone12.svg  — composite SVG frames (vector)
 *   ├── phone.webp ... phone6.webp  — assembled 9-slice frames (raster)
 *   ├── phone13.webp, tablet*.webp  — assembled 9-slice frames (raster)
 *   └── masks/phone11.svg ...       — framebuffer mask SVGs (screen clip-paths)
 *
 * Requires: pdftocairo (from poppler, `brew install poppler`)
 * Uses: sharp (already a project dependency)
 *
 * Gracefully skips if Xcode/DeviceKit is not installed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CHROME_DIR = '/Library/Developer/DeviceKit/Chrome';
const DEVICE_TYPES_DIR = '/Library/Developer/CoreSimulator/Profiles/DeviceTypes';
const OUTPUT_DIR = join(__dir, '../apps/web/public/device-chrome');
const RENDER_SCALE = 4; // 4x resolution for crisp raster frames

function log(msg) {
  console.log(`[prepare-device-chrome] ${msg}`);
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

function hasPdftocairo() {
  try {
    execFileSync('pdftocairo', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(CHROME_DIR)) {
  log('DeviceKit not found — skipping (Xcode not installed?)');
  process.exit(0);
}

if (!existsSync(DEVICE_TYPES_DIR)) {
  log('CoreSimulator profiles not found — skipping');
  process.exit(0);
}

if (!hasPdftocairo()) {
  log('pdftocairo not found — install with: brew install poppler');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plistExtract(plistPath, key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', plistPath], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function readChromeJson(chromeId) {
  const jsonPath = join(CHROME_DIR, `${chromeId}.devicechrome`, 'Contents/Resources/chrome.json');
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, 'utf8'));
}

function convertPdfToSvg(pdfPath, svgPath) {
  execFileSync('pdftocairo', ['-svg', pdfPath, svgPath], { stdio: 'pipe' });
}

function convertPdfToPng(pdfPath, outPrefix, dpi = 72 * RENDER_SCALE) {
  execFileSync('pdftocairo', ['-png', '-r', String(dpi), pdfPath, outPrefix], { stdio: 'pipe' });
  // pdftocairo appends -1.png
  return `${outPrefix}-1.png`;
}

// ---------------------------------------------------------------------------
// Step 1: Scan device types → build deviceType→chrome mapping
// ---------------------------------------------------------------------------

log('scanning device type profiles...');

/** @type {Record<string, { chromeId: string, screenW: number, screenH: number, scale: number, maskId: string | null }>} */
const deviceProfiles = {};

const deviceTypeDirs = readdirSync(DEVICE_TYPES_DIR).filter((d) => d.endsWith('.simdevicetype'));

for (const dir of deviceTypeDirs) {
  const profilePath = join(DEVICE_TYPES_DIR, dir, 'Contents/Resources/profile.plist');
  if (!existsSync(profilePath)) continue;

  const chromeRaw = plistExtract(profilePath, 'chromeIdentifier');
  if (!chromeRaw) continue;

  // Only include phone and tablet chromes (skip watch, tv, etc.)
  const chromeId = chromeRaw.replace('com.apple.dt.devicekit.chrome.', '');
  if (!chromeId.startsWith('phone') && !chromeId.startsWith('tablet')) continue;

  const screenW = Number(plistExtract(profilePath, 'mainScreenWidth')) || 0;
  const screenH = Number(plistExtract(profilePath, 'mainScreenHeight')) || 0;
  const scaleRaw = plistExtract(profilePath, 'mainScreenScale');
  const scale = scaleRaw ? parseFloat(scaleRaw) : (screenW > 1000 ? 3 : 2);
  const maskId = plistExtract(profilePath, 'framebufferMask');

  // Device type name from the directory (e.g. "iPhone 16 Pro")
  const deviceName = dir.replace('.simdevicetype', '');

  deviceProfiles[deviceName] = { chromeId, screenW, screenH, scale, maskId };
}

log(`found ${Object.keys(deviceProfiles).length} device profiles`);

// ---------------------------------------------------------------------------
// Step 2: Determine unique chromes to process
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const chromeIds = new Set();
/** @type {Record<string, { screenW: number, screenH: number, scale: number }>} */
const chromeScreenDims = {};

for (const profile of Object.values(deviceProfiles)) {
  chromeIds.add(profile.chromeId);
  // Use the first device's screen dims as representative for each chrome
  if (!chromeScreenDims[profile.chromeId]) {
    chromeScreenDims[profile.chromeId] = {
      screenW: profile.screenW,
      screenH: profile.screenH,
      scale: profile.scale,
    };
  }
}

log(`unique chromes to process: ${[...chromeIds].join(', ')}`);

// ---------------------------------------------------------------------------
// Step 3: Process each chrome — convert to SVG or assemble from 9-slice
// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(join(OUTPUT_DIR, 'masks'), { recursive: true });

const tmpDir = join(OUTPUT_DIR, '.tmp');
mkdirSync(tmpDir, { recursive: true });

/** @type {Record<string, { asset: string, screen: { top: number, left: number, width: number, height: number } }>} */
const chromeAssets = {};

for (const chromeId of chromeIds) {
  const chromeJson = readChromeJson(chromeId);
  if (!chromeJson) {
    log(`  ${chromeId}: chrome.json not found, skipping`);
    continue;
  }

  const images = chromeJson.images;
  const sizing = images.sizing;
  const chromeDir = join(CHROME_DIR, `${chromeId}.devicechrome`, 'Contents/Resources');
  const hasComposite = existsSync(join(chromeDir, 'PhoneComposite.pdf'));

  if (hasComposite) {
    // --- Composite: direct PDF → SVG conversion ---
    const svgFile = `${chromeId}.svg`;
    const svgPath = join(OUTPUT_DIR, svgFile);
    convertPdfToSvg(join(chromeDir, 'PhoneComposite.pdf'), svgPath);

    // Parse SVG viewBox to get total dimensions
    const svgContent = readFileSync(svgPath, 'utf8');
    const vbMatch = svgContent.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const totalW = vbMatch ? parseFloat(vbMatch[1]) : 0;
    const totalH = vbMatch ? parseFloat(vbMatch[2]) : 0;

    // Screen area: the inner rect after bezel (sizing + padding)
    // From the SVG clip paths, screen starts at (sizing.leftWidth-1, sizing.topHeight-1)
    // and extends to (totalW - sizing.rightWidth+1, totalH - sizing.bottomHeight+1)
    const screenLeft = sizing.leftWidth - 1;
    const screenTop = sizing.topHeight - 1;
    const screenW = totalW - screenLeft - (sizing.rightWidth - 1);
    const screenH = totalH - screenTop - (sizing.bottomHeight - 1);

    chromeAssets[chromeId] = {
      asset: `/device-chrome/${svgFile}`,
      aspectRatio: `${totalW} / ${totalH}`,
      screen: {
        top: (screenTop / totalH) * 100,
        left: (screenLeft / totalW) * 100,
        right: ((totalW - screenLeft - screenW) / totalW) * 100,
        bottom: ((totalH - screenTop - screenH) / totalH) * 100,
      },
    };
    log(`  ${chromeId}: composite → SVG (${totalW}x${totalH})`);
  } else {
    // --- 9-slice: convert pieces, assemble with sharp ---
    const dims = chromeScreenDims[chromeId];
    if (!dims || dims.screenW === 0) {
      log(`  ${chromeId}: no screen dimensions available, skipping`);
      continue;
    }

    const screen1xW = Math.round(dims.screenW / dims.scale);
    const screen1xH = Math.round(dims.screenH / dims.scale);

    // Piece names from chrome.json
    const pieceNames = {
      tl: images.topLeft,
      top: images.top,
      tr: images.topRight,
      right: images.right,
      br: images.bottomRight,
      bottom: images.bottom,
      bl: images.bottomLeft,
      left: images.left,
    };

    // Convert each piece to PNG at RENDER_SCALE
    const pieceTmpDir = join(tmpDir, chromeId);
    mkdirSync(pieceTmpDir, { recursive: true });

    let conversionFailed = false;
    for (const [key, name] of Object.entries(pieceNames)) {
      const pdfPath = join(chromeDir, `${name}.pdf`);
      if (!existsSync(pdfPath)) {
        log(`  ${chromeId}: missing piece ${name}.pdf, skipping chrome`);
        conversionFailed = true;
        break;
      }
      convertPdfToPng(pdfPath, join(pieceTmpDir, key));
    }
    if (conversionFailed) continue;

    // Assemble with sharp
    const sharp = (await import('sharp')).default;

    const tlMeta = await sharp(join(pieceTmpDir, 'tl-1.png')).metadata();
    const cornerW = tlMeta.width ?? 0;
    const cornerH = tlMeta.height ?? 0;
    if (!cornerW || !cornerH) {
      log(`  ${chromeId}: corner piece has zero dimensions, skipping`);
      continue;
    }

    const bezelL = sizing.leftWidth * RENDER_SCALE;
    const bezelR = sizing.rightWidth * RENDER_SCALE;
    const bezelT = sizing.topHeight * RENDER_SCALE;
    const bezelB = sizing.bottomHeight * RENDER_SCALE;

    const renderScreenW = screen1xW * RENDER_SCALE;
    const renderScreenH = screen1xH * RENDER_SCALE;
    const totalW = renderScreenW + bezelL + bezelR;
    const totalH = renderScreenH + bezelT + bezelB;

    const tl = await sharp(join(pieceTmpDir, 'tl-1.png')).toBuffer();
    const tr = await sharp(join(pieceTmpDir, 'tr-1.png')).toBuffer();
    const bl = await sharp(join(pieceTmpDir, 'bl-1.png')).toBuffer();
    const br = await sharp(join(pieceTmpDir, 'br-1.png')).toBuffer();
    const topEdge = await sharp(join(pieceTmpDir, 'top-1.png'))
      .resize(totalW - 2 * cornerW, cornerH)
      .toBuffer();
    const bottomEdge = await sharp(join(pieceTmpDir, 'bottom-1.png'))
      .resize(totalW - 2 * cornerW, cornerH)
      .toBuffer();
    const leftEdge = await sharp(join(pieceTmpDir, 'left-1.png'))
      .resize(cornerW, totalH - 2 * cornerH)
      .toBuffer();
    const rightEdge = await sharp(join(pieceTmpDir, 'right-1.png'))
      .resize(cornerW, totalH - 2 * cornerH)
      .toBuffer();

    const webpFile = `${chromeId}.webp`;
    await sharp({
      create: {
        width: totalW,
        height: totalH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: tl, left: 0, top: 0 },
        { input: topEdge, left: cornerW, top: 0 },
        { input: tr, left: totalW - cornerW, top: 0 },
        { input: leftEdge, left: 0, top: cornerH },
        { input: rightEdge, left: totalW - cornerW, top: cornerH },
        { input: bl, left: 0, top: totalH - cornerH },
        { input: bottomEdge, left: cornerW, top: totalH - cornerH },
        { input: br, left: totalW - cornerW, top: totalH - cornerH },
      ])
      .webp({ quality: 90 })
      .toFile(join(OUTPUT_DIR, webpFile));

    // Screen area percentages
    const screenLeftPx = bezelL;
    const screenTopPx = bezelT;

    const screenRightPx = totalW - screenLeftPx - renderScreenW;
    const screenBottomPx = totalH - screenTopPx - renderScreenH;

    chromeAssets[chromeId] = {
      asset: `/device-chrome/${webpFile}`,
      aspectRatio: `${totalW} / ${totalH}`,
      screen: {
        top: (screenTopPx / totalH) * 100,
        left: (screenLeftPx / totalW) * 100,
        right: (screenRightPx / totalW) * 100,
        bottom: (screenBottomPx / totalH) * 100,
      },
    };

    const sizeKB = Math.round(
      readFileSync(join(OUTPUT_DIR, webpFile)).length / 1024
    );
    log(`  ${chromeId}: 9-slice → WebP ${totalW}x${totalH} (${sizeKB}KB)`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Extract framebuffer masks (screen clip-path SVGs)
// ---------------------------------------------------------------------------

log('extracting framebuffer masks...');

/** @type {Record<string, string>} */
const maskPaths = {};
const processedMasks = new Set();

for (const [deviceName, profile] of Object.entries(deviceProfiles)) {
  if (!profile.maskId || processedMasks.has(profile.maskId)) continue;
  processedMasks.add(profile.maskId);

  const maskPdf = join(
    DEVICE_TYPES_DIR,
    `${deviceName}.simdevicetype`,
    'Contents/Resources',
    `${profile.maskId}.pdf`
  );
  if (!existsSync(maskPdf)) continue;

  const maskSvgFile = `masks/${profile.chromeId}.svg`;
  const maskSvgPath = join(OUTPUT_DIR, maskSvgFile);

  // Only create one mask per chrome (they share the same shape)
  if (existsSync(maskSvgPath)) {
    maskPaths[profile.chromeId] = `/device-chrome/${maskSvgFile}`;
    continue;
  }

  convertPdfToSvg(maskPdf, maskSvgPath);
  maskPaths[profile.chromeId] = `/device-chrome/${maskSvgFile}`;
  log(`  mask for ${profile.chromeId}: ${profile.maskId}`);
}

// ---------------------------------------------------------------------------
// Step 5: Generate manifest.json
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
const manifest = {};

for (const [deviceName, profile] of Object.entries(deviceProfiles)) {
  const chrome = chromeAssets[profile.chromeId];
  if (!chrome) continue;

  manifest[deviceName] = {
    chromeId: profile.chromeId,
    asset: chrome.asset,
    aspectRatio: chrome.aspectRatio,
    screen: chrome.screen,
    mask: maskPaths[profile.chromeId] || null,
  };
}

writeFileSync(join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
log(`wrote manifest.json with ${Object.keys(manifest).length} device entries`);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

rmSync(tmpDir, { recursive: true, force: true });

const totalAssets = readdirSync(OUTPUT_DIR).filter(
  (f) => f.endsWith('.svg') || f.endsWith('.webp')
).length;
const masksCount = existsSync(join(OUTPUT_DIR, 'masks'))
  ? readdirSync(join(OUTPUT_DIR, 'masks')).length
  : 0;

log(`done — ${totalAssets} frame assets + ${masksCount} masks`);
