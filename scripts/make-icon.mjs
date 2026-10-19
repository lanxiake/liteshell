/**
 * Draws build/icon.png — a terminal window with a `>_` prompt.
 *
 * No image library: shapes are signed distance fields, which give clean
 * antialiased edges for free, and PNG is small enough to write by hand.
 * electron-builder derives the .ico / .icns / linux sizes from this one file.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = 512

// Same colors the app ships with, so the icon matches the default theme.
const BG_TOP = [0x17, 0x1c, 0x28]
const BG_BOTTOM = [0x0d, 0x10, 0x16]
const ACCENT = [0x5b, 0x8c, 0xff]
const CURSOR = [0xc9, 0xd1, 0xdd]

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Signed distance to a capsule (thick line with round caps). */
function sdSegment(x, y, ax, ay, bx, by, r) {
  const pax = x - ax
  const pay = y - ay
  const bax = bx - ax
  const bay = by - ay
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/** Distance -> coverage, i.e. a one-pixel soft edge. */
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d))

function blend(px, i, rgb, alpha) {
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - alpha) + rgb[c] * alpha)
}

const px = Buffer.alloc(SIZE * SIZE * 4)
const radius = 108

for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1)
  const bg = BG_TOP.map((v, c) => Math.round(v + (BG_BOTTOM[c] - v) * t))
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const body = sdRoundRect(x + 0.5, y + 0.5, SIZE / 2, SIZE / 2, 232, 232, radius)
    const a = cover(body)
    if (a <= 0) continue
    px[i + 3] = Math.round(a * 255)
    blend(px, i, bg, 1)
    // A hairline of the accent around the edge reads as "this is a window".
    blend(px, i, ACCENT, cover(Math.abs(body + 3) - 1.5) * 0.45)
    // The prompt: a chevron and a block cursor.
    const chevron = Math.min(
      sdSegment(x + 0.5, y + 0.5, 152, 158, 254, 256, 19),
      sdSegment(x + 0.5, y + 0.5, 254, 256, 152, 354, 19)
    )
    blend(px, i, ACCENT, cover(chevron))
    blend(px, i, CURSOR, cover(sdRoundRect(x + 0.5, y + 0.5, 330, 336, 46, 19, 12)))
  }
}

/* ---------------- PNG ---------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// One filter byte per row; filter 0 (none) keeps this readable.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = new URL('../build/icon.png', import.meta.url)
writeFileSync(out, png)
console.log(`${SIZE}x${SIZE} → build/icon.png (${(png.length / 1024).toFixed(1)} KB)`)
