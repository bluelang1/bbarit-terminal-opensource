// Self-contained QR Code generator (byte mode) — no external dependencies.
// Ported from the public-domain "qrcode-generator" core (K. Arase), trimmed to
// 8-bit byte mode with automatic version selection. Used by the Remote Channels
// gateway UI to render an offline-capable QR without adding an npm dependency.

const PAD0 = 0xec;
const PAD1 = 0x11;

// Error correction level M (medium).
const RS_BLOCK_TABLE_M: number[][] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
  [4, 49, 31],
  [2, 60, 38, 2, 61, 39],
  [3, 58, 36, 2, 59, 37],
  [4, 69, 43, 1, 70, 44],
  [1, 80, 50, 4, 81, 51],
  [6, 58, 36, 2, 59, 37],
  [8, 59, 37, 1, 60, 38],
  [4, 64, 40, 5, 65, 41],
  [5, 65, 41, 5, 66, 42],
  [7, 73, 45, 3, 74, 46],
  [10, 74, 46, 1, 75, 47],
  [9, 69, 43, 4, 70, 44],
  [3, 70, 44, 11, 71, 45],
  [3, 67, 41, 13, 68, 42],
];

const EXP = new Array<number>(256);
const LOG = new Array<number>(256);
(function initGf() {
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (let i = 8; i < 256; i++) {
    EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
  }
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
})();

function gexp(n: number): number {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP[n];
}
function glog(n: number): number {
  return LOG[n];
}

function polyMultiply(a: number[], b: number[]): number[] {
  const num = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      num[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
    }
  }
  return num;
}

function polyMod(dividend: number[], divisor: number[]): number[] {
  let num = dividend.slice();
  while (num.length - divisor.length >= 0) {
    const ratio = glog(num[0]) - glog(divisor[0]);
    const next = num.slice();
    for (let i = 0; i < divisor.length; i++) {
      next[i] ^= gexp(glog(divisor[i]) + ratio);
    }
    // Trim leading zeros.
    let start = 0;
    while (start < next.length && next[start] === 0) start++;
    num = next.slice(start);
    if (num.length === 0) break;
  }
  return num;
}

function errorCorrectionPolynomial(ecLength: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLength; i++) {
    poly = polyMultiply(poly, [1, gexp(i)]);
  }
  return poly;
}

class BitBuffer {
  buffer: number[] = [];
  length = 0;
  put(num: number, bits: number) {
    for (let i = 0; i < bits; i++) {
      this.putBit(((num >>> (bits - i - 1)) & 1) === 1);
    }
  }
  putBit(bit: boolean) {
    const idx = Math.floor(this.length / 8);
    if (this.buffer.length <= idx) this.buffer.push(0);
    if (bit) this.buffer[idx] |= 0x80 >>> this.length % 8;
    this.length++;
  }
}

// BCH format-info bits (level M mask combos).
function bchFormatInfo(data: number): number {
  let d = data << 10;
  const g = 0b10100110111;
  while (bchDigit(d) - bchDigit(g) >= 0) {
    d ^= g << (bchDigit(d) - bchDigit(g));
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}
function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

function rsBlocks(typeNumber: number): { total: number; data: number }[] {
  const raw = RS_BLOCK_TABLE_M[typeNumber - 1];
  const list: { total: number; data: number }[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const count = raw[i];
    const total = raw[i + 1];
    const data = raw[i + 2];
    for (let j = 0; j < count; j++) list.push({ total, data });
  }
  return list;
}

function createData(typeNumber: number, bytes: number[]): number[] {
  const blocks = rsBlocks(typeNumber);
  const buffer = new BitBuffer();
  // Byte mode indicator + char count.
  buffer.put(4, 4);
  buffer.put(bytes.length, typeNumber < 10 ? 8 : 16);
  for (const b of bytes) buffer.put(b, 8);

  let totalDataCount = 0;
  for (const b of blocks) totalDataCount += b.data;

  if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  while (buffer.buffer.length < totalDataCount) {
    buffer.buffer.push(PAD0);
    if (buffer.buffer.length < totalDataCount) buffer.buffer.push(PAD1);
  }
  return createBytes(buffer, blocks, totalDataCount);
}

function createBytes(
  buffer: BitBuffer,
  blocks: { total: number; data: number }[],
  _totalDataCount: number,
): number[] {
  let offset = 0;
  let maxDc = 0;
  let maxEc = 0;
  const dcData: number[][] = [];
  const ecData: number[][] = [];

  for (const block of blocks) {
    const dcCount = block.data;
    const ecCount = block.total - block.data;
    maxDc = Math.max(maxDc, dcCount);
    maxEc = Math.max(maxEc, ecCount);

    const dc = new Array<number>(dcCount);
    for (let i = 0; i < dcCount; i++) dc[i] = buffer.buffer[i + offset] & 0xff;
    offset += dcCount;

    const rsPoly = errorCorrectionPolynomial(ecCount);
    const dividend = dc.concat(new Array<number>(rsPoly.length - 1).fill(0));
    const mod = polyMod(dividend, rsPoly);
    const ec = new Array<number>(rsPoly.length - 1);
    for (let i = 0; i < ec.length; i++) {
      const modIndex = i + mod.length - ec.length;
      ec[i] = modIndex >= 0 ? mod[modIndex] : 0;
    }
    dcData.push(dc);
    ecData.push(ec);
  }

  const out: number[] = [];
  for (let i = 0; i < maxDc; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < dcData[b].length) out.push(dcData[b][i]);
    }
  }
  for (let i = 0; i < maxEc; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < ecData[b].length) out.push(ecData[b][i]);
    }
  }
  return out;
}

function utf8Bytes(text: string): number[] {
  const encoder = new TextEncoder();
  return Array.from(encoder.encode(text));
}

function chooseTypeNumber(byteLength: number): number {
  // Byte-mode capacity at level M for versions 1..20 (matches RS_BLOCK_TABLE_M).
  const capacity = [
    14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450,
    504, 560, 624, 666,
  ];
  for (let i = 0; i < capacity.length; i++) {
    if (byteLength <= capacity[i]) return i + 1;
  }
  throw new Error('QR: data too long');
}

class QrModel {
  typeNumber: number;
  moduleCount: number;
  modules: (boolean | null)[][];
  dataCache: number[];

  constructor(bytes: number[]) {
    this.typeNumber = chooseTypeNumber(bytes.length);
    this.moduleCount = this.typeNumber * 4 + 17;
    this.modules = [];
    this.dataCache = createData(this.typeNumber, bytes);
    this.makeBestMask();
  }

  private setupModules(maskPattern: number) {
    const count = this.moduleCount;
    this.modules = Array.from({ length: count }, () =>
      new Array<boolean | null>(count).fill(null),
    );
    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(count - 7, 0);
    this.setupPositionProbePattern(0, count - 7);
    this.setupPositionAdjustPattern();
    this.setupTimingPattern();
    this.setupTypeInfo(maskPattern);
    this.mapData(this.dataCache, maskPattern);
  }

  private setupPositionProbePattern(row: number, col: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= this.moduleCount || cc < 0 || cc >= this.moduleCount)
          continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        this.modules[rr][cc] = dark;
      }
    }
  }

  private setupTimingPattern() {
    for (let i = 8; i < this.moduleCount - 8; i++) {
      if (this.modules[i][6] === null) this.modules[i][6] = i % 2 === 0;
      if (this.modules[6][i] === null) this.modules[6][i] = i % 2 === 0;
    }
  }

  private setupPositionAdjustPattern() {
    const pos = ADJUST_PATTERN[this.typeNumber - 1];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i];
        const col = pos[j];
        if (this.modules[row][col] !== null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            this.modules[row + r][col + c] =
              r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          }
        }
      }
    }
  }

  private setupTypeInfo(maskPattern: number) {
    const data = (0b00 << 3) | maskPattern; // level M = 0b00
    const bits = bchFormatInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >> i) & 1) === 1;
      if (i < 6) this.modules[i][8] = mod;
      else if (i < 8) this.modules[i + 1][8] = mod;
      else this.modules[this.moduleCount - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >> i) & 1) === 1;
      if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
      else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
      else this.modules[8][15 - i - 1] = mod;
    }
    this.modules[this.moduleCount - 8][8] = true;
  }

  private mapData(data: number[], maskPattern: number) {
    let inc = -1;
    let row = this.moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = this.moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (this.modules[row][col - c] === null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFn(maskPattern, row, col - c)) dark = !dark;
            this.modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || row >= this.moduleCount) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  private makeBestMask() {
    let bestPattern = 0;
    let bestScore = Infinity;
    for (let pattern = 0; pattern < 8; pattern++) {
      this.setupModules(pattern);
      const score = this.penaltyScore();
      if (score < bestScore) {
        bestScore = score;
        bestPattern = pattern;
      }
    }
    this.setupModules(bestPattern);
  }

  private penaltyScore(): number {
    const n = this.moduleCount;
    const at = (r: number, c: number) => this.modules[r][c] === true;
    let score = 0;

    // Rule 1: runs of 5+ same-color modules (rows and columns).
    for (let mode = 0; mode < 2; mode++) {
      for (let a = 0; a < n; a++) {
        let prev = -1;
        let run = 0;
        for (let b = 0; b < n; b++) {
          const v = (mode === 0 ? at(a, b) : at(b, a)) ? 1 : 0;
          if (v === prev) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else {
            prev = v;
            run = 1;
          }
        }
      }
    }

    // Rule 2: 2x2 same-color blocks.
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = at(r, c);
        if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
          score += 3;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with 4 light modules on a side.
    const pat = [true, false, true, true, true, false, true];
    const before = [false, false, false, false];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // Horizontal.
        if (c + 7 <= n) {
          let ok = true;
          for (let k = 0; k < 7; k++) if (at(r, c + k) !== pat[k]) ok = false;
          if (ok) {
            let lightBefore = true;
            for (let k = 0; k < 4; k++)
              if (c - 4 + k < 0 || at(r, c - 4 + k) !== before[k])
                lightBefore = false;
            let lightAfter = true;
            for (let k = 0; k < 4; k++)
              if (c + 7 + k >= n || at(r, c + 7 + k) !== before[k])
                lightAfter = false;
            if (lightBefore || lightAfter) score += 40;
          }
        }
        // Vertical.
        if (r + 7 <= n) {
          let ok = true;
          for (let k = 0; k < 7; k++) if (at(r + k, c) !== pat[k]) ok = false;
          if (ok) {
            let lightBefore = true;
            for (let k = 0; k < 4; k++)
              if (r - 4 + k < 0 || at(r - 4 + k, c) !== before[k])
                lightBefore = false;
            let lightAfter = true;
            for (let k = 0; k < 4; k++)
              if (r + 7 + k >= n || at(r + 7 + k, c) !== before[k])
                lightAfter = false;
            if (lightBefore || lightAfter) score += 40;
          }
        }
      }
    }

    // Rule 4: deviation of dark-module ratio from 50%.
    let dark = 0;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (at(r, c)) dark++;
    const ratio = Math.abs((dark * 100) / (n * n) - 50) / 5;
    score += Math.floor(ratio) * 10;
    return score;
  }

  isDark(row: number, col: number): boolean {
    return this.modules[row][col] === true;
  }
}

function maskFn(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default:
      return false;
  }
}

// Alignment-pattern center coordinates per version (1..20).
const ADJUST_PATTERN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

/**
 * Render `text` as a QR code SVG string (level M, byte mode, auto version).
 * Returns an inline SVG suitable for a data URI or dangerouslySetInnerHTML.
 */
export function qrToSvg(
  text: string,
  opts: { size?: number; margin?: number; dark?: string; light?: string } = {},
): string {
  const model = new QrModel(utf8Bytes(text));
  const count = model.moduleCount;
  const margin = opts.margin ?? 4;
  const size = opts.size ?? 240;
  const total = count + margin * 2;
  const dark = opts.dark ?? '#000000';
  const light = opts.light ?? '#ffffff';

  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (model.isDark(r, c)) {
        rects += `<rect x="${c + margin}" y="${r + margin}" width="1.02" height="1.02"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<g fill="${dark}">${rects}</g></svg>`
  );
}

/** Render `text` as a QR code data URI (image/svg+xml). */
export function qrToDataUri(
  text: string,
  opts?: { size?: number; margin?: number; dark?: string; light?: string },
): string {
  const svg = qrToSvg(text, opts);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

