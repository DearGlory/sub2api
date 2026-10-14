import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { decodePng, encodePng } from './tail-probe-lib/png.mjs'

export const hash = b => crypto.createHash('sha256').update(b).digest('hex')
export const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null }
const inside = (x, y, poly) => {
  let yes = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) yes = !yes
  }
  return yes
}
export function measureImage(img, axis, valid = null) {
  const { w, h, chans, data } = img
  const pixels = [], palette = new Map(), bands = Array.from({ length: 10 }, () => ({ area: 0, lit: 0, warm: 0, cool: 0, neutral: 0, luminance: 0, cross: [], bright: 0 }))
  const [hx, hy, tx, ty] = axis, length = Math.hypot(tx - hx, ty - hy), ax = (tx - hx) / length, ay = (ty - hy) / length
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const index = y * w + x
    if (valid && !valid[index]) continue
    const a = ((x - hx) * ax + (y - hy) * ay) / length, s = -(x - hx) * ay + (y - hy) * ax, b = bands[Math.min(9, Math.max(0, Math.floor(a * 10)))]
    if (a < 0 || a > 1) continue
    b.area++
    const p = index * chans, r = data[p], g = data[p + 1], blue = data[p + 2], l = .2126 * r + .7152 * g + .0722 * blue
    if (l < 12) continue
    const kind = r > blue * 1.15 ? 'warm' : blue > r * 1.15 ? 'cool' : 'neutral'
    b.lit++; b[kind]++; b.luminance += l; b.cross.push(s); if (l >= 180) b.bright++
    pixels.push({ a, s, l, kind })
    const key = [r, g, blue].map(v => Math.min(240, Math.floor(v / 32) * 32 + 16)).join(',')
    palette.set(key, (palette.get(key) || 0) + 1)
  }
  const span = rows => rows.length ? { lengthPx: (quantile(rows.map(p => p.a), .98) - quantile(rows.map(p => p.a), .02)) * length, widthPx: quantile(rows.map(p => p.s), .98) - quantile(rows.map(p => p.s), .02), count: rows.length } : null
  return { status: 'measured-not-visual-verdict', width: w, height: h, axis, axisLengthPx: length,
    method: 'sRGB display pixels; luminance>=12 foreground, >=180 bright; warm R>1.15B / cool B>1.15R; 2–98% extents. These are segmentation settings, NOT acceptance thresholds. Head=first 20% of annotated axis. Pixel occupancy is NOT a particle count.',
    palette: [...palette].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([rgb, count]) => ({ rgb: rgb.split(',').map(Number), count })),
    head: span(pixels.filter(p => p.a < .2)), tail: span(pixels.filter(p => p.a >= .2)), total: span(pixels),
    bands: bands.map((b, i) => ({ axialRange: [i / 10, (i + 1) / 10], area: b.area, lit: b.lit, occupancy: b.area ? b.lit / b.area : null, warm: b.warm, cool: b.cool, neutral: b.neutral, bright: b.bright, meanLitLuminance: b.lit ? b.luminance / b.lit : null, cross02: quantile(b.cross, .02), cross98: quantile(b.cross, .98) })) }
}
export async function referenceEvidence(reference, out, decodedFile = null) {
  await fs.mkdir(out, { recursive: true })
  const buffer = await fs.readFile(reference), img = decodePng(decodedFile ? await fs.readFile(decodedFile) : buffer)
  if (img.w !== 1200 || img.h !== 1600 || img.chans < 3) throw Error('Reference adapter requires the inspected 1200x1600 RGB star.png; another image needs explicit reviewed annotations')
  const crop = [124, 466, 1076, 1116], polygon = [[124,945],[1000,467],[1075,467],[1075,880],[300,1115],[124,1115]]
  const w = crop[2] - crop[0], h = crop[3] - crop[1], rgb = Buffer.alloc(w * h * 3), mask = Buffer.alloc(w * h * 3), valid = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x + crop[0], sy = y + crop[1], i = y * w + x
    if (!inside(sx, sy, polygon)) continue
    valid[i] = 1; mask.fill(255, i * 3, i * 3 + 3)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = img.data[(sy * img.w + sx) * img.chans + c]
  }
  const axis = [150 - crop[0], 1035 - crop[1], 1060 - crop[0], 560 - crop[1]]
  await fs.writeFile(path.join(out, 'reference-crop.png'), encodePng(w, h, rgb))
  await fs.writeFile(path.join(out, 'reference-mask.png'), encodePng(w, h, mask))
  const result = { source: path.resolve(reference), sourceSha256: hash(buffer), sourceSize: [img.w, img.h], crop, polygon,
    exclusion: 'Polygon mask removes tablet, white border, clock/date and watermark; excluded pixels black and excluded from statistics, never inpainted. Head and far tail are clipped by the original screen; measured extents are lower bounds. Mask is a reviewable annotation, not automatically inferred truth.',
    ...measureImage({ w, h, chans: 3, data: rgb }, axis, valid) }
  await fs.writeFile(path.join(out, 'reference.json'), JSON.stringify(result, null, 2))
  return result
}
export async function comparison(referenceFile, renderFile, outFile, head, tip) {
  const ref = decodePng(await fs.readFile(referenceFile)), render = decodePng(await fs.readFile(renderFile))
  const panelW = ref.w, panelH = ref.h, output = Buffer.alloc(panelW * 2 * panelH * 3), destHead = [26, 569], destTip = [936, 94]
  const dx = destTip[0] - destHead[0], dy = destTip[1] - destHead[1], sx = tip[0] - head[0], sy = tip[1] - head[1]
  const den = dx * dx + dy * dy, a = (sx * dx + sy * dy) / den, b = (sy * dx - sx * dy) / den
  for (let y = 0; y < panelH; y++) for (let x = 0; x < panelW; x++) {
    const sourceX = Math.round(head[0] + a * (x - destHead[0]) - b * (y - destHead[1])), sourceY = Math.round(head[1] + b * (x - destHead[0]) + a * (y - destHead[1]))
    for (let c = 0; c < 3; c++) {
      output[(y * panelW * 2 + x) * 3 + c] = ref.data[(y * ref.w + x) * ref.chans + c]
      if (sourceX >= 0 && sourceX < render.w && sourceY >= 0 && sourceY < render.h) output[(y * panelW * 2 + x + panelW) * 3 + c] = render.data[(sourceY * render.w + sourceX) * render.chans + c]
    }
  }
  await fs.writeFile(outFile, encodePng(panelW * 2, panelH, output))
  return { file: outFile, mapping: 'Left reference / right real compositor screenshot. Uniform rotation+scale only, aligning head and measured tail endpoint; no anisotropic stretch or recolor. Absolute projected extent remains in JSON.', head, tip, scale: 1 / Math.hypot(a, b) }
}
