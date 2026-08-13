#!/usr/bin/env node
/**
 * Generates extension icons as plain PNGs, with no dependencies beyond
 * Node's built-in zlib. Renders at 4x supersampling and box-downsamples for
 * anti-aliasing, since there's no canvas/image library available in this
 * environment.
 *
 * Usage: node scripts/make-icons.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;

const BG = [17, 24, 39]; // slate-900-ish, shared across all icons

// Each target draws its own layers via `draw(layers, ss)`, where `layers`
// exposes the primitive drawing ops below (ring/dot/wedge), and `ss` is the
// supersampled canvas size in px so shapes can be positioned proportionally.
const TARGETS = [
  {
    outDir: ["extensions", "spawn-highlighter", "icons"],
    // Two concentric "breathing rings" + a center dot, echoing the
    // highlight animation content.js draws over Nation/Tribe territory.
    draw(layers, ss) {
      layers.ring(ss * 0.36, ss * 0.075, [255, 201, 74], 0.95); // gold
      layers.ring(ss * 0.22, ss * 0.065, [72, 229, 255], 0.95); // cyan
      layers.dot(ss * 0.05, [255, 255, 255], 0.9);
    },
  },
  {
    outDir: ["extensions", "attack-radar", "icons"],
    // A radar bezel with a sweeping wedge and a red target blip, evoking
    // the "who's about to get attacked" scan this mod performs.
    draw(layers, ss) {
      layers.ring(ss * 0.36, ss * 0.045, [255, 201, 74], 0.9); // amber bezel
      layers.wedge(ss * 0.36, -100, -20, [255, 201, 74], 0.35); // sweep
      layers.dot(ss * 0.045, [255, 255, 255], 0.5); // radar origin
      layers.dot(ss * 0.06, [255, 90, 90], 0.95, {
        x: ss * 0.24,
        y: -ss * 0.14,
      }); // target blip, offset from center
      layers.ring(ss * 0.14, ss * 0.035, [255, 90, 90], 0.8, {
        x: ss * 0.24,
        y: -ss * 0.14,
      }); // blip's danger ring
    },
  },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Render one icon at `size` px into an RGBA buffer for the given target. */
function renderIcon(target, size) {
  const ss = size * SUPERSAMPLE;
  const big = new Float64Array(ss * ss * 4);

  const set = (x, y, rgb, alpha) => {
    if (x < 0 || y < 0 || x >= ss || y >= ss) return;
    const i = (y * ss + x) * 4;
    const srcA = alpha;
    const dstA = big[i + 3];
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c++) {
      const src = rgb[c] * srcA;
      const dst = big[i + c] * dstA;
      big[i + c] = (src + dst * (1 - srcA)) / outA;
    }
    big[i + 3] = outA;
  };

  // Background: rounded square.
  const r = ss * 0.22;
  for (let y = 0; y < ss; y++) {
    for (let x = 0; x < ss; x++) {
      const dx = Math.min(x - r, ss - 1 - x - r, 0);
      const dy = Math.min(y - r, ss - 1 - y - r, 0);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r + 0.5) {
        set(x, y, BG, clamp(r + 0.5 - d, 0, 1));
      }
    }
  }

  const cx = ss / 2;
  const cy = ss / 2;

  const layers = {
    ring(radius, thickness, rgb, alpha, center) {
      const ocx = cx + (center?.x ?? 0);
      const ocy = cy + (center?.y ?? 0);
      for (let y = 0; y < ss; y++) {
        for (let x = 0; x < ss; x++) {
          const dx = x + 0.5 - ocx;
          const dy = y + 0.5 - ocy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const dist = Math.abs(d - radius);
          if (dist <= thickness / 2) {
            set(x, y, rgb, alpha * clamp(thickness / 2 - dist + 0.5, 0, 1));
          }
        }
      }
    },
    dot(radius, rgb, alpha, center) {
      const ocx = cx + (center?.x ?? 0);
      const ocy = cy + (center?.y ?? 0);
      for (let y = 0; y < ss; y++) {
        for (let x = 0; x < ss; x++) {
          const dx = x + 0.5 - ocx;
          const dy = y + 0.5 - ocy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= radius + 0.5) {
            set(x, y, rgb, alpha * clamp(radius + 0.5 - d, 0, 1));
          }
        }
      }
    },
    // Pie slice from startDeg to endDeg (0deg = +x axis, clockwise).
    wedge(radius, startDeg, endDeg, rgb, alpha) {
      const start = (startDeg * Math.PI) / 180;
      const end = (endDeg * Math.PI) / 180;
      for (let y = 0; y < ss; y++) {
        for (let x = 0; x < ss; x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > radius + 0.5) continue;
          let a = Math.atan2(dy, dx);
          if (a < start) a += Math.PI * 2;
          if (a < start || a > end) continue;
          const edge = clamp(radius + 0.5 - d, 0, 1);
          set(x, y, rgb, alpha * edge);
        }
      }
    },
  };

  target.draw(layers, ss);

  // Box-downsample ss x ss -> size x size.
  const out = new Uint8ClampedArray(size * size * 4);
  const box = SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < box; sy++) {
        for (let sx = 0; sx < box; sx++) {
          const i = ((y * box + sy) * ss + (x * box + sx)) * 4;
          r += big[i];
          g += big[i + 1];
          b += big[i + 2];
          a += big[i + 3];
        }
      }
      const n = box * box;
      const o = (y * size + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = (a / n) * 255;
    }
  }
  return out;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) {
      raw[rowStart + 1 + x] = rgba[y * size * 4 + x];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const target of TARGETS) {
  const outDir = path.join(__dirname, "..", ...target.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    const rgba = renderIcon(target, size);
    const png = encodePNG(rgba, size);
    const outPath = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${png.length} bytes)`);
  }
}
