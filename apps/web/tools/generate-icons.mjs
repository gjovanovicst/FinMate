#!/usr/bin/env node
/**
 * Generate the PWA icons — task 4.3.2a.
 *
 * ## Why this writes PNGs by hand
 *
 * The icons have to be real binary assets in `apps/web/public/`, and every other route to them needs
 * something the repository does not have: an image library (a new dependency, rule 9), a design tool
 * (not reproducible in review), or a browser screenshot (Playwright, an open dependency decision).
 * `node:zlib` plus a CRC32 is enough to write a PNG, and the mark is geometry — a rounded square and
 * three bars — so the whole asset set is ~100 lines of arithmetic that anyone can re-run and diff.
 *
 * Run: `pnpm icons:generate` (writes into `apps/web/public/`).
 *
 * ## What an install actually needs (docs/07 §4.7)
 *
 * Chromium's install criteria are a manifest with `name`/`short_name`, `start_url`, `display:
 * standalone`, a 192 px and a 512 px icon, and a registered service worker with a fetch handler — the
 * worker is ADR-024's, already shipped. **Maskable** is separate: Android crops a maskable icon to its
 * own shape, so the glyph must sit inside the safe zone (a circle of 80 % diameter) with a full-bleed
 * background, or the launcher cuts the mark. iOS ignores the manifest's icons for the Home Screen and
 * uses `apple-touch-icon`, and it applies its own mask — hence a third, full-bleed variant.
 *
 * @module apps/web/tools/generate-icons
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The brand, read from `styles.css` by eye: `--color-primary` dark theme. A static asset cannot read a token. */
const BRAND = [0x7c, 0x6c, 0xf5];
const INK = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** RGBA8 → PNG. Filter 0 on every scanline: the images are flat, so a smarter filter buys nothing. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing

/** Inside a rectangle with rounded corners? Both shapes below are this, with radius 0 for a plain rect. */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

/**
 * The mark: an "F" in three bars, over a rounded square.
 *
 * `bleed` draws the background to the edges (maskable + iOS, which apply their own mask); `glyph` is the
 * glyph's width as a fraction of the canvas, which is smaller for maskable so the OS crop cannot reach it.
 */
function draw(size, { bleed, radius, glyph }) {
  const rgba = Buffer.alloc(size * size * 4);
  const g = (size * glyph) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = g * 0.34;
  const bars = [
    // stem
    [cx - g, cy - g, cx - g + stroke, cy + g, 0],
    // top bar
    [cx - g, cy - g, cx + g, cy - g + stroke, 0],
    // middle bar, shorter: it is what makes the shape read as an F rather than a Π
    [cx - g, cy - stroke / 2, cx + g * 0.45, cy + stroke / 2, 0],
  ];
  const samples = 4;
  const step = 1 / samples;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let background = 0;
      let ink = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          const insideSquare = bleed
            ? px >= 0 && py >= 0 && px <= size && py <= size
            : inRoundedRect(px, py, 0, 0, size, size, radius);
          if (!insideSquare) continue;
          background += 1;
          if (bars.some(([l, t, r, b, rad]) => inRoundedRect(px, py, l, t, r, b, rad))) ink += 1;
        }
      }
      const total = samples * samples;
      const alpha = background / total;
      const inkShare = background === 0 ? 0 : ink / background;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(BRAND[channel] * (1 - inkShare) + INK[channel] * inkShare);
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });

const files = [
  // Rounded, transparent outside the corner radius: the launcher shows the shape we drew.
  ['icon-192.png', draw(192, { bleed: false, radius: 192 * 0.22, glyph: 0.62 })],
  ['icon-512.png', draw(512, { bleed: false, radius: 512 * 0.22, glyph: 0.62 })],
  // Maskable: full bleed, glyph inside the 80 % safe zone, so any launcher mask keeps the mark.
  ['icon-maskable-512.png', draw(512, { bleed: true, radius: 0, glyph: 0.5 })],
  // iOS applies its own mask and ignores `purpose`, so this one bleeds too.
  ['apple-touch-icon.png', draw(180, { bleed: true, radius: 0, glyph: 0.6 })],
];

for (const [name, buffer] of files) {
  writeFileSync(join(OUT, name), buffer);
  console.log(`${name.padEnd(24)} ${(buffer.length / 1024).toFixed(1)} KB`);
}
