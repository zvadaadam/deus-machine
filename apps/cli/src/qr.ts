/**
 * Minimal QR code generator for terminal display.
 *
 * Zero dependencies. Supports byte mode, Error Correction Level L,
 * versions 1-5. Uses Unicode half-block characters for compact rendering.
 *
 * Based on the QR code specification (ISO/IEC 18004).
 */

// ── GF(256) Arithmetic ──────────────────────────────────────────────

// QR codes use GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  EXP[255] = EXP[0];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

// ── Reed-Solomon ────────────────────────────────────────────────────

function rsGeneratorPoly(n: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const result = new Uint8Array(data.length + ecCount);
  result.set(data);

  for (let i = 0; i < data.length; i++) {
    const coef = result[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        result[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }

  return result.slice(data.length);
}

// ── Version Info ────────────────────────────────────────────────────

// [total codewords, ec codewords per block, num blocks] for Level L
const VERSION_INFO: [number, number, number][] = [
  [0, 0, 0],       // v0 placeholder
  [26, 7, 1],      // v1: 26 total, 7 EC, 1 block → 19 data
  [44, 10, 1],     // v2: 44 total, 10 EC → 34 data
  [70, 15, 1],     // v3: 70 total, 15 EC → 55 data
  [100, 20, 1],    // v4: 100 total, 20 EC → 80 data
  [134, 26, 1],    // v5: 134 total, 26 EC → 108 data
];

// Alignment pattern positions by version (v2+)
const ALIGNMENT_POS: number[][] = [
  [],          // v0
  [],          // v1
  [6, 18],     // v2
  [6, 22],     // v3
  [6, 26],     // v4
  [6, 30],     // v5
];

function getVersion(dataLen: number): number {
  for (let v = 1; v <= 5; v++) {
    const [total, ec] = VERSION_INFO[v];
    const dataCapacity = total - ec;
    // Byte mode overhead: 4 bits mode + 8/16 bits length + data + 4 bits terminator
    const overhead = v <= 9 ? 2 : 3; // mode + length indicator bytes (approx)
    if (dataLen + overhead <= dataCapacity) return v;
  }
  throw new Error("Data too long for QR version 1-5");
}

// ── Data Encoding ───────────────────────────────────────────────────

function encodeData(data: string, version: number): Uint8Array {
  const [totalCW, ecCW] = VERSION_INFO[version];
  const dataCW = totalCW - ecCW;
  const buf = new Uint8Array(dataCW);

  // Bit writer
  let bitPos = 0;
  function writeBits(val: number, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      if (val & (1 << i)) {
        buf[bitPos >> 3] |= 0x80 >> (bitPos & 7);
      }
      bitPos++;
    }
  }

  // Mode indicator: byte mode = 0100
  writeBits(0b0100, 4);

  // Character count: 8 bits for v1-9
  writeBits(data.length, 8);

  // Data bytes
  for (let i = 0; i < data.length; i++) {
    writeBits(data.charCodeAt(i) & 0xff, 8);
  }

  // Terminator
  writeBits(0, Math.min(4, dataCW * 8 - bitPos));

  // Pad to byte boundary
  bitPos = Math.ceil(bitPos / 8) * 8;

  // Pad codewords (0xEC, 0x11 alternating)
  let padByte = 0;
  const padPatterns = [0xec, 0x11];
  while (bitPos < dataCW * 8) {
    writeBits(padPatterns[padByte % 2], 8);
    padByte++;
  }

  return buf;
}

// ── Matrix Construction ─────────────────────────────────────────────

function createMatrix(version: number): { matrix: number[][]; size: number } {
  const size = 17 + version * 4;
  const matrix: number[][] = [];
  for (let i = 0; i < size; i++) {
    matrix.push(new Array(size).fill(-1)); // -1 = not yet set
  }
  return { matrix, size };
}

function addFinderPattern(matrix: number[][], row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r;
      const mc = col + c;
      if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;

      if (r === -1 || r === 7 || c === -1 || c === 7) {
        matrix[mr][mc] = 0; // separator (white)
      } else if (r === 0 || r === 6 || c === 0 || c === 6) {
        matrix[mr][mc] = 1; // outer border
      } else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) {
        matrix[mr][mc] = 1; // inner square
      } else {
        matrix[mr][mc] = 0;
      }
    }
  }
}

function addAlignmentPattern(matrix: number[][], row: number, col: number) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const mr = row + r;
      const mc = col + c;
      if (matrix[mr][mc] !== -1) continue; // Don't overwrite finder

      if (Math.abs(r) === 2 || Math.abs(c) === 2) {
        matrix[mr][mc] = 1;
      } else if (r === 0 && c === 0) {
        matrix[mr][mc] = 1;
      } else {
        matrix[mr][mc] = 0;
      }
    }
  }
}

function addTimingPatterns(matrix: number[][], size: number) {
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === -1) matrix[6][i] = i % 2 === 0 ? 1 : 0;
    if (matrix[i][6] === -1) matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }
}

function reserveFormatArea(matrix: number[][], size: number) {
  // Around top-left finder
  for (let i = 0; i <= 8; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
  }
  // Around top-right finder
  for (let i = 0; i <= 7; i++) {
    if (matrix[8][size - 1 - i] === -1) matrix[8][size - 1 - i] = 0;
  }
  // Around bottom-left finder
  for (let i = 0; i <= 7; i++) {
    if (matrix[size - 1 - i][8] === -1) matrix[size - 1 - i][8] = 0;
  }
  // Dark module
  matrix[size - 8][8] = 1;
}

function placeData(matrix: number[][], size: number, dataBits: number[]) {
  let bitIdx = 0;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // Skip timing column

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || matrix[row][c] !== -1) continue;
        matrix[row][c] = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
      }
    }

    upward = !upward;
  }
}

// ── Masking ─────────────────────────────────────────────────────────

type MaskFn = (row: number, col: number) => boolean;

const MASKS: MaskFn[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix: number[][], reserved: boolean[][], size: number, maskIdx: number): number[][] {
  const masked = matrix.map((r) => [...r]);
  const fn = MASKS[maskIdx];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) {
        masked[r][c] ^= 1;
      }
    }
  }

  return masked;
}

function scoreMask(matrix: number[][], size: number): number {
  let score = 0;

  // Penalty 1: adjacent same-color modules in rows/cols
  for (let r = 0; r < size; r++) {
    let count = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        count++;
        if (count === 5) score += 3;
        else if (count > 5) score += 1;
      } else {
        count = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let count = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        count++;
        if (count === 5) score += 3;
        else if (count > 5) score += 1;
      } else {
        count = 1;
      }
    }
  }

  // Penalty 3: finder-like patterns
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 7; c++) {
      if (
        matrix[r][c] === 1 && matrix[r][c+1] === 0 && matrix[r][c+2] === 1 &&
        matrix[r][c+3] === 1 && matrix[r][c+4] === 1 && matrix[r][c+5] === 0 &&
        matrix[r][c+6] === 1
      ) {
        score += 40;
      }
    }
  }

  return score;
}

// ── Format Info ─────────────────────────────────────────────────────

// Pre-computed format info strings for Level L (EC=01), masks 0-7
// Format: EC level (2 bits) + mask (3 bits) + BCH error correction (10 bits)
const FORMAT_STRINGS: number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function placeFormatInfo(matrix: number[][], size: number, maskIdx: number) {
  const bits = FORMAT_STRINGS[maskIdx];

  // Bits 0-7 along left column (bottom to top at col 8)
  // Bits 8-14 along top row (left to right at row 8)
  const positions1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const positions2: [number, number][] = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];

  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    const [r1, c1] = positions1[i];
    matrix[r1][c1] = bit;
    const [r2, c2] = positions2[i];
    matrix[r2][c2] = bit;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Generate QR code as array of terminal-ready strings.
 * Uses Unicode half-block characters: two QR rows per terminal line.
 */
export function generateQR(data: string): string[] {
  const version = getVersion(data.length);
  const [totalCW, ecCW] = VERSION_INFO[version];
  const size = 17 + version * 4;

  // Encode data
  const dataCodewords = encodeData(data, version);
  const ecCodewords = rsEncode(dataCodewords, ecCW);

  // Interleave data + EC into bit stream
  const allCodewords = new Uint8Array(totalCW);
  allCodewords.set(dataCodewords);
  allCodewords.set(ecCodewords, dataCodewords.length);

  const dataBits: number[] = [];
  for (const byte of allCodewords) {
    for (let bit = 7; bit >= 0; bit--) {
      dataBits.push((byte >> bit) & 1);
    }
  }

  // Build matrix
  const { matrix } = createMatrix(version);

  // Add fixed patterns
  addFinderPattern(matrix, 0, 0);
  addFinderPattern(matrix, 0, size - 7);
  addFinderPattern(matrix, size - 7, 0);
  addTimingPatterns(matrix, size);

  // Alignment patterns (v2+)
  const alignPos = ALIGNMENT_POS[version];
  if (alignPos.length > 0) {
    for (const r of alignPos) {
      for (const c of alignPos) {
        // Skip if overlaps with finder
        if (r <= 8 && c <= 8) continue;
        if (r <= 8 && c >= size - 8) continue;
        if (r >= size - 8 && c <= 8) continue;
        addAlignmentPattern(matrix, r, c);
      }
    }
  }

  // Reserve format area
  reserveFormatArea(matrix, size);

  // Track which cells are reserved (non-data)
  const reserved: boolean[][] = matrix.map((r) => r.map((v) => v !== -1));

  // Place data
  placeData(matrix, size, dataBits);

  // Try all masks, pick best
  let bestMask = 0;
  let bestScore = Infinity;

  for (let m = 0; m < 8; m++) {
    const masked = applyMask(matrix, reserved, size, m);
    placeFormatInfo(masked, size, m);
    const score = scoreMask(masked, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = m;
    }
  }

  // Apply best mask
  const final = applyMask(matrix, reserved, size, bestMask);
  placeFormatInfo(final, size, bestMask);

  // Render with quiet zone (1 module border)
  const qSize = size + 2;
  const lines: string[] = [];

  // Use half-block rendering: two QR rows per terminal line
  // █ = both black, ▀ = top black / bottom white, ▄ = top white / bottom black, ' ' = both white
  // QR convention: dark module = 1, light = 0
  // Terminal: we render dark as block characters on default bg

  for (let r = 0; r < qSize; r += 2) {
    let line = "";
    for (let c = 0; c < qSize; c++) {
      const topR = r - 1;
      const botR = r;
      const col = c - 1;

      const top = (topR >= 0 && topR < size && col >= 0 && col < size) ? final[topR][col] : 0;
      const bot = (botR >= 0 && botR < size && col >= 0 && col < size) ? final[botR][col] : 0;

      if (top && bot) {
        line += "\u2588"; // █ full block
      } else if (top && !bot) {
        line += "\u2580"; // ▀ upper half
      } else if (!top && bot) {
        line += "\u2584"; // ▄ lower half
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }

  return lines;
}

/** Print QR code with indent */
export function printQR(data: string, indent = 4): void {
  const pad = " ".repeat(indent);
  try {
    const lines = generateQR(data);
    for (const line of lines) {
      console.log(pad + line);
    }
  } catch {
    // If QR generation fails (data too long), just skip it silently
  }
}
