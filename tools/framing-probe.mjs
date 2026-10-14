/**
 * framing-probe — independent acceptance probe for the home-page particle feature.
 *
 * Verifies V3, V5, V6, V7 and V8 from HOME-PARTICLE-V2-SPEC.md §4 against a real
 * Chrome over CDP. Nothing here trusts the page's own reporting: every number is
 * read either from the live three.js scene or out of the screenshot's pixels.
 *
 * Why this file exists at all
 * --------------------------
 * A previous attempt at this measurement produced a CONSTANT glyph bbox of
 * 0.7453 x 0.809 of the viewport at every hold, across a camera that travelled from
 * camZ 18 to 36. That is physically impossible — the projected share of a fixed
 * world height falls as `1 / (camZ - SUBJECT_Z)`, so it must have roughly halved —
 * and the constant 1152 px behind it is the page's own `max-w-6xl` container
 * (fw = 1152/1424 = 0.809 exactly). The instrument had measured the page chrome.
 *
 * So the primitive is validated here, on known answers, before it is used:
 *
 *   CALIBRATION  an injected marker at an exact CSS rect must come back from the
 *                framebuffer at exactly that rect (px == CSS px * dpr), and with
 *                the marker absent and the scene hidden the frame must be black.
 *   SCENE-GRAPH  the cloud and the starfield are switched off at the scene graph
 *                for every glyph measurement. Pixels then contain the glyph and
 *                nothing else. On the previous run the starfield alone supplied
 *                ~1500 components and blew the union bbox out to the full frame.
 *   CROSS-CHECK  every V6 verdict is computed three independent ways — projected
 *                from the live position attribute, measured from pixels, and
 *                projected from the levelled anchor buffer — and they must agree.
 *   SELF-CHECK   `camZ` is read alongside every sample. fh is a monotone function
 *                of camZ, so if camZ moves over a wide span while fh does not, the
 *                measurement is broken and the probe reports INSTRUMENT INVALID
 *                instead of answering the question it was asked.
 *
 * Two traps that cost real time, recorded so they are not re-learned:
 *   - `* { visibility: hidden !important }` beats a marker rule that is not also
 *     `!important`. The calibration marker needs `!important`.
 *   - calling `engine.stop()` starves the headless compositor and
 *     `Page.captureScreenshot` then returns STALE frames — a marker was measured
 *     three captures after it had been set. The engine stays running.
 *
 * Usage:
 *   node tools/framing-probe.mjs [--url=http://127.0.0.1:5210/] [--out=DIR]
 *                               [--viewport=1440x900] [--hold-samples=3]
 *                               [--discriminate]
 *
 * `--discriminate` is the probe's own falsification test: it halves the glyph
 * anchors at runtime through the dev handle and asserts that the V6 verdict flips
 * to FAIL. A probe that cannot fail proves nothing.
 *
 * Exit code is 0 only when every criterion passes AND the instrument validated.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/)
    return m ? [m[1], m[2] === '' ? 'true' : m[2]] : [a, 'true']
  })
)

const URL_ = args.url || 'http://127.0.0.1:5210/'
/**
 * Paths default relative to this file's own location (`<repo>/tools/`), so the probe
 * works from a checkout at any path without needing `--repo`.
 */
const OUT = resolve(args.out || 'E:/Global-session/xiao-ui-redesign-20261009-194449/shots/framing-probe')
const PORT = Number(args.port || 9522)
const CHROME = args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROFILE = args.profile || 'E:/Global-session/xiao-ui-redesign-20261009-194449/.chrome-probe-9522'
const REPO = resolve(args.repo || join(HERE, '..'))
const FRONTEND = join(REPO, 'frontend')

/** Spec §4: the pattern must be at least this share of the viewport. */
const MIN_HEIGHT_SHARE = 2 / 3
const MIN_WIDTH_SHARE = 1 / 3
/** V3: the comet's on-screen angular size must hold within this jitter. */
const MAX_JITTER = 0.15
/**
 * V3: how much the sweep's whole-sweep fh range must span before a between-brand step
 * can be attributed to a brand at all. Both levelled brands sit a fraction of a percent
 * apart, so a sweep that draws two same-height brands cannot answer the brand-vs-camera
 * question — that is reported as not answered rather than as a page defect. This is the
 * threshold the criterion always used; it is named so the "not answered" branch can cite
 * it instead of hard-coding a second copy of the number.
 */
const BRAND_STEP_MIN = 0.01

/**
 * Viewports from spec §4 V6, plus a 3x-DPR phone pass. The DPR is part of the
 * case: the pixel primitive scales with it and the engine's `maxDpr` cap means the
 * canvas backing store does not.
 */
const VIEWPORTS = [
  { name: '1440x900', w: 1440, h: 900, dpr: 1 },
  { name: '1920x1080', w: 1920, h: 1080, dpr: 1 },
  { name: '390x844', w: 390, h: 844, dpr: 3, mobile: true },
  { name: '900x1400', w: 900, h: 1400, dpr: 1 },
]

/**
 * The two brands that bracket the roster's bbox aspect (measured 0.70 for groq to
 * 1.63 for xiaomimimo). V6's width floor bites on the narrow mark and the height
 * floor on the square one, so a run that never shows both cannot tell a passing
 * glyph from a glyph that simply never met the binding constraint.
 */
const EXTREME_BRANDS = ['groq', 'xiaomimimo']
/** A square-ish mark as a control, so a brand-specific failure is visible as such. */
const CONTROL_BRANDS = ['openai']

const GLYPH_WORLD_HEIGHT = 10.08
/** How long to wait for a hold phase, in ms. A beat is 12 s, so 60 s is ample. */
const HOLD_BUDGET_MS = Number(args['hold-budget-ms'] || 60000)
const DOLLY_SAMPLES = Number(args['dolly-samples'] || 8)
const V5_SERIES_MS = Number(args['v5-series-ms'] || 40000)
/** `--viewports=1440x900,390x844` limits the V6 sweep; default is all four. */
const VIEWPORT_FILTER = args.viewports ? String(args.viewports).split(',').map((s) => s.trim()) : null
/** The CDP call timeout must exceed the longest page-side wait. */
const EVAL_TIMEOUT_MS = Number(args['eval-timeout-ms'] || HOLD_BUDGET_MS + 30000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })
if (!args['no-chrome']) mkdirSync(PROFILE, { recursive: true })

// ---------------------------------------------------------------------------
// Chrome + CDP
// ---------------------------------------------------------------------------

const chrome = args['no-chrome']
  ? null
  : spawn(CHROME, [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--window-size=1440,900',
      '--use-angle=d3d11',
      'about:blank',
    ], { stdio: 'ignore' })

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch { /* browser still coming up */ }
    await sleep(400)
  }
  throw new Error('no CDP page target on port ' + PORT)
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) }
      }, EVAL_TIMEOUT_MS)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { __error: JSON.stringify(r.exceptionDetails).slice(0, 400) }
    return r.result?.value
  }
  async png() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }
}

// ---------------------------------------------------------------------------
// PNG decode + measurement primitives
// ---------------------------------------------------------------------------

/** Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced. Enough for Chrome captures. */
function decodePng(buf) {
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4)
      depth = body[8]; color = body[9]; interlace = body[12]
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (interlace) throw new Error('interlaced PNG is not supported')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const chan = { 0: 1, 2: 3, 4: 2, 6: 4 }[color]
  if (!chan || (depth !== 8 && depth !== 16)) throw new Error('unsupported PNG colour type/depth')
  const sampleBytes = depth / 8
  const bpp = chan * sampleBytes
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 255
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w, h, chan, sampleBytes, bpp, stride, data: out }
}

/** One luminance byte per pixel, so thresholds are cheap and comparable. */
function toLum(img) {
  const n = img.w * img.h
  const lum = new Uint8Array(n)
  const s = img.sampleBytes
  for (let i = 0; i < n; i++) {
    const j = i * img.bpp
    lum[i] = (0.2126 * img.data[j] + 0.7152 * img.data[j + s] + 0.0722 * img.data[j + 2 * s]) | 0
  }
  return lum
}

/** Union bounding box of every pixel at or above `thr`. */
function litBbox(lum, w, h, thr) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, lit = 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (lum[row + x] >= thr) {
        lit++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!lit) return { lit: 0 }
  return { lit, x0: minX, x1: maxX, y0: minY, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 8-connected components at `thr`, sorted by size descending.
 *
 * `exclude` is an optional 0/1 pixel map whose set pixels are treated as not-lit and
 * never enter the scan. Excluding BEFORE the scan rather than filtering the component
 * list afterwards matters: the list is capped at `maxComps`, and a large glyph can
 * produce far more fragments than the cap, at which point the survivors are whatever
 * happened to come first in raster order (the top rows of the frame) — a silent
 * spatial bias on top of the noise.
 */
function components(lum, w, h, thr, maxComps = 4000, exclude = null) {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) if (lum[i] >= thr && !(exclude && exclude[i])) mask[i] = 1
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const comps = []
  for (let i = 0; i < mask.length && comps.length < maxComps; i++) {
    if (!mask[i] || seen[i]) continue
    let sp = 0
    stack[sp++] = i
    seen[i] = 1
    let size = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
    while (sp) {
      const q = stack[--sp]
      const qy = (q / w) | 0
      const qx = q - qy * w
      size++
      if (qx < minX) minX = qx
      if (qx > maxX) maxX = qx
      if (qy < minY) minY = qy
      if (qy > maxY) maxY = qy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const nn = ny * w + nx
          if (mask[nn] && !seen[nn]) { seen[nn] = 1; stack[sp++] = nn }
        }
      }
    }
    comps.push({ size, x0: minX, x1: maxX, y0: minY, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }
  comps.sort((a, b) => b.size - a.size)
  const out = comps
  out.hitCap = comps.length >= maxComps
  return out
}

/**
 * Turn a list of boxes (in image pixels) into a 0/1 pixel map to exclude from the
 * component scan — the pattern's own projected footprint, so its particle gaps are
 * never mistaken for stars.
 */
function exclusionMask(boxes, w, h) {
  const mask = new Uint8Array(w * h)
  let count = 0
  for (const b of boxes) {
    if (!b) continue
    const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(w - 1, Math.ceil(b.x1))
    const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(h - 1, Math.ceil(b.y1))
    for (let y = y0; y <= y1; y++) {
      const row = y * w
      for (let x = x0; x <= x1; x++) if (!mask[row + x]) { mask[row + x] = 1; count++ }
    }
  }
  return { mask, count }
}

/** Pixels where two frames differ by more than `delta` — the fault-injection readout. */
function diffMask(a, b, delta) {
  const n = Math.min(a.length, b.length)
  const m = new Uint8Array(n)
  let count = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > delta) { m[i] = 1; count++ }
  }
  return { m, count }
}

function maskBbox(m, w, h) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, lit = 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (m[row + x]) {
        lit++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!lit) return { lit: 0 }
  return { lit, x0: minX, x1: maxX, y0: minY, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  if (dx <= 0 || dy <= 0) return null
  return num / Math.sqrt(dx * dy)
}

/**
 * Pooled WITHIN-GROUP slope — the fixed-effects estimator — of `y` on `x`.
 *
 * Why this exists: on a V3 sweep the roster advances while the dolly does, so `brand`
 * and `camZ` are perfectly confounded. Across the eight samples the roster moves
 * through three brands whose levelled glyphs sit at slightly different shares (the
 * 4%-ish step the runs show), so a plain `corr(camZ, fh)` over all eight samples is
 * reporting the BRAND difference and calling it a camera effect. The earlier
 * `corr = 0.6879` was exactly that: within a brand `fh` moved by ~0.2%, and the 5%
 * apparent "trend" was the claude -> gemini -> grok steps lining up with camZ.
 *
 * Demeaning each group before pooling removes any per-group offset, so the slope that
 * survives is the response to `x` measured *inside* a brand. The control slope is
 * computed with the same estimator over the same grouping, which makes the ratio of
 * the two an apples-to-apples comparison: "how much does the measurement move per
 * unit camZ, against how much a world-nailed comet would move per unit camZ".
 *
 * Returns `slope: null` when no group has any spread in `x` — in which case the
 * confound could not be removed and the caller must say so rather than report a pass.
 */
function withinGroupSlope(points, groupOf) {
  const groups = new Map()
  for (const p of points) {
    const g = groupOf(p)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(p)
  }
  let sxy = 0, sxx = 0, syy = 0, groupsUsed = 0, usable = 0
  const perGroup = []
  for (const [g, arr] of groups) {
    // Every point in a group must have finite x and y. A single NaN anywhere in the
    // arithmetic would poison the pooled sums into NaN, and NaN comparisons are all
    // false — so `sxx <= 0` would not fire and the slope would quietly come back NaN
    // while every guard downstream still read as "many". Refusing the group outright is
    // the only safe handling; the caller then reports that the confound could not be
    // removed instead of accepting a number that is not one.
    const bad = arr.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    if (arr.length < 2 || bad) {
      perGroup.push({ group: g, n: arr.length, usable: false, reason: bad ? 'non-finite x or y' : 'fewer than 2 points' })
      continue
    }
    const mx = mean(arr.map((p) => p.x))
    const my = mean(arr.map((p) => p.y))
    let gxx = 0, gxy = 0, gyy = 0
    for (const p of arr) {
      const a = p.x - mx, b = p.y - my
      gxx += a * a; gxy += a * b; gyy += b * b
    }
    if (!(gxx > 0)) {
      perGroup.push({ group: g, n: arr.length, usable: false, reason: 'no spread in x within this group' })
      continue
    }
    groupsUsed++; usable += arr.length
    sxx += gxx; sxy += gxy; syy += gyy
    perGroup.push({
      group: g, n: arr.length, usable: true,
      camZSpan: round(Math.max(...arr.map((p) => p.x)) - Math.min(...arr.map((p) => p.x)), 3),
      yRange: [round(Math.min(...arr.map((p) => p.y)), 4), round(Math.max(...arr.map((p) => p.y)), 4)],
      ySpreadPct: round(((Math.max(...arr.map((p) => p.y)) - Math.min(...arr.map((p) => p.y))) / (my || 1)) * 100, 2),
    })
  }
  const finite = Number.isFinite(sxx) && Number.isFinite(sxy) && Number.isFinite(syy) && sxx > 0
  if (!finite) return { slope: null, corr: null, groupsUsed, usable, sxx: 0, syy, sxy, perGroup }
  return {
    slope: sxy / sxx,
    corr: syy > 0 ? sxy / Math.sqrt(sxx * syy) : null,
    groupsUsed, usable, sxx, syy, sxy, perGroup,
  }
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
const spread = (a) => (a.length ? (Math.max(...a) - Math.min(...a)) / (mean(a) || 1) : NaN)
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v)

// ---------------------------------------------------------------------------
// Page-side snippets
// ---------------------------------------------------------------------------

/**
 * Hide every DOM element except the canvas, and paint the document black.
 *
 * `!important` on the universal rule is deliberate and load-bearing: without it a
 * later `visibility: visible` wins, and the marker below then measures as zero.
 */
const ISOLATE = `(() => {
  let st = document.getElementById('framing-probe-isolate');
  if (!st) { st = document.createElement('style'); st.id = 'framing-probe-isolate'; document.head.appendChild(st) }
  st.textContent = 'html,body{background:#000 !important} *{visibility:hidden !important}'
    + ' canvas{visibility:visible !important} #framing-probe-marker{visibility:visible !important}';
  const host = document.querySelector('[data-testid="home-particle-background"]');
  if (host) { const sky = host.querySelector('.home-space-sky'); if (sky) sky.style.display = 'none' }
  return { ok: true, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio };
})()`

/** Put the DOM back, so a later check (V8's light/dark test) sees the real page. */
const RESTORE = `(() => {
  const st = document.getElementById('framing-probe-isolate');
  if (st) st.remove();
  const m = document.getElementById('framing-probe-marker');
  if (m) m.remove();
  const host = document.querySelector('[data-testid="home-particle-background"]');
  if (host) { const sky = host.querySelector('.home-space-sky'); if (sky) sky.style.display = '' }
  return true;
})()`

/**
 * The exclusion mask for a star-flow measurement, built from BOTH captured frames.
 *
 * Masking only the first frame's footprint is not enough, and the failure it produces
 * looks like a physics result: the comet patrols and its head sweeps during a 7 s
 * window, so frame B's cloud sits somewhere frame A's box does not cover. Its particle
 * fragments then survive into the candidate set, get nearest-neighbour matched to frame
 * A's entirely different fragments, and the "drift" they report is enormous and
 * meaningless. The fingerprint is a large candidate-count asymmetry between the two
 * frames — the LF run showed frame A with 246 candidates against frame B with 2441.
 *
 * The box itself needs NO cloud-spread allowance, which is the trap this helper used to
 * fall into: `live` is the projection of the `position` attribute, i.e. every particle's
 * ACTUAL world position, so it already bounds the whole visible cloud in that frame. An
 * earlier version padded it by `maxAnchorDist`, which is the distance from a particle to
 * its glyph anchor — a quantity that is naturally enormous during `scatter`, when the
 * particles are dispersed by design and nowhere near their anchors. That inflated the
 * mask to 100% of the frame and left nothing to measure: the run measured 0 candidate
 * stars in all three phases, with every one of 3225 unmasked candidates inside the box.
 *
 * The margin therefore covers only what `live` genuinely does not: the glow sprite's
 * radius, which extends half a sprite past each particle's centre, in raster pixels.
 */
function buildFlowMask(frames, geoms, { padPx = 4 } = {}) {
  const boxes = []
  const parts = []
  for (let i = 0; i < frames.length; i++) {
    const geom = geoms[i], frame = frames[i]
    const live = geom && geom.live
    if (!live || !Number.isFinite(live.x0)) { parts.push({ i, reason: 'no live projection' }); continue }
    const sx = live.W ? frame.img.w / live.W : 1
    const sy = live.H ? frame.img.h / live.H : 1
    // The sprite's world radius as a share of the viewport height, converted to the
    // frame's own raster pixels. `visH` is the frustum's world height at the content
    // plane, so `spriteWorld / visH` is the share and `* frameH` is the pixels.
    const visH = geom.visH
    const spritePx = Number.isFinite(visH) && visH > 0 ? (SPRITE_WORLD_RADIUS / visH) * frame.img.h : 0
    const margin = Math.max(1, Math.ceil(spritePx + padPx))
    boxes.push({
      x0: (live.x0 - margin) * sx, x1: (live.x1 + margin) * sx,
      y0: (live.y0 - margin) * sy, y1: (live.y1 + margin) * sy,
    })
    parts.push({ i, marginPx: margin, spritePx: round(spritePx, 1), scale: [round(sx, 3), round(sy, 3)] })
  }
  if (!boxes.length) return { exclude: null, boxes: null, count: 0, frameFrac: 0, parts, reason: 'no frame had a usable projection' }
  const frame = frames[0]
  const { mask, count } = exclusionMask(boxes, frame.img.w, frame.img.h)
  const frac = count / (frame.img.w * frame.img.h)
  // A mask that swallows most of the frame has nothing left to measure, and that must be
  // said rather than reported as "no stars found". The trigger is stated as a share so
  // the caller can render it as a fact about the layout.
  const tooLarge = frac > 0.9
  return {
    exclude: mask, boxes, count, frameFrac: round(frac, 4), tooLarge,
    parts, marginPx: Math.max(...parts.map((p) => p.marginPx || 0)),
    reason: tooLarge ? `the comet's projected footprint covers ${(frac * 100).toFixed(1)}% of the frame — ` +
      `there is no sky left to measure the star flow in` : undefined,
  }
}

/** A white rect at an exact CSS position — the pixel primitive's known answer. */
const MARKER = (x, y, w, h, on) => `(() => {
  const old = document.getElementById('framing-probe-marker');
  if (old) old.remove();
  if (!${on}) return { removed: true };
  const d = document.createElement('div');
  d.id = 'framing-probe-marker';
  d.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;'
    + 'background:#ffffff;z-index:2147483647;visibility:visible !important;';
  document.body.appendChild(d);
  const r = d.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`

/**
 * Gate actual render objects, including the independent causal-emitted-tail pool.
 * A visibility accessor holds the gate across phase updates without stopping rAF.
 * On release restore the descriptor and the latest value requested by the engine.
 * (true, true) releases the gate; glyph mode admits ONLY debugScene.points.
 */
const SET_VIS = (points, stars) => `(() => {
  const key = '__FRAMING_VIS_GATE__';
  const release = () => {
    const gate = window[key];
    if (!gate) return;
    for (const row of gate.rows) {
      Object.defineProperty(row.object, 'visible', { ...row.descriptor, value: row.latest });
    }
    delete window[key];
  };
  release();
  if (${points && stars}) return { restored: true };
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng) throw new Error('no engine handle');
  const { scene, points: glyph } = eng.debugScene;
  const sf = scene.getObjectByName('starfield');
  if (!glyph || !sf) throw new Error('missing glyph or starfield render object');
  const objects = new Map([[glyph, ${points}], [sf, ${stars}]]);
  const inStars = object => {
    for (let p = object; p; p = p.parent) if (p === sf) return true;
    return false;
  };
  // Descend the real scene rather than assuming one comet draw object forever.
  // Keep the existing star mask/geometry definitions; tail is never glyph geometry.
  scene.traverse(object => {
    if (object !== glyph && object.geometry && object.material && !inStars(object)) objects.set(object, false);
  });
  for (const tail of [eng.tailPoints, scene.getObjectByName('causal-emitted-tail')]) {
    if (tail && tail !== glyph) objects.set(tail, false);
  }
  const rows = [...objects].map(([object, forced]) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, 'visible');
    if (!descriptor || !descriptor.configurable || !descriptor.writable || !('value' in descriptor)) {
      throw new Error('unsupported visible descriptor: ' + object.name);
    }
    return { object, forced, descriptor, latest: descriptor.value };
  });
  window[key] = { rows };
  for (const row of rows) Object.defineProperty(row.object, 'visible', {
    configurable: true, enumerable: row.descriptor.enumerable,
    get: () => row.forced,
    set: value => { row.latest = value; },
  });
  return { points: glyph.visible, stars: sf.visible,
    objects: rows.map(row => ({ name: row.object.name || '(glyph)', visible: row.object.visible })) };
})()`

/** Pair every gate with release, including a screenshot/evaluation exception. */
async function withSceneVisibility(cdp, points, stars, action) {
  const state = await cdp.eval(SET_VIS(points, stars))
  if (!state || state.__error || state.error) throw new Error('scene isolation failed: ' + JSON.stringify(state))
  try {
    return await action(state)
  } finally {
    const restored = await cdp.eval(SET_VIS(true, true))
    if (!restored?.restored) throw new Error('scene isolation restore failed: ' + JSON.stringify(restored))
  }
}

/** Phase, brand, camera and the viewport, in one read. */
const STATE = `(() => {
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  const s = window.__SUB2API_PARTICLE_STATS__;
  if (!eng) return { error: 'no engine handle' };
  const cam = eng.debugScene.camera;
  const ch = eng.choreography && eng.choreography.state;
  return { phase: s ? s.phase : null, brand: s ? s.brandSlug : null,
    camZ: +cam.position.z.toFixed(4), fov: cam.fov, aspect: +cam.aspect.toFixed(4),
    phaseProgress: ch ? +ch.phaseProgress.toFixed(4) : null,
    brandIndex: ch ? ch.brandIndex : null,
    subjectZ: +eng.debugScene.points.position.z.toFixed(4),
    iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio };
})()`

/**
 * Project the cloud into screen pixels straight from the live `position`
 * attribute — the independent cross-check on the pixel measurement.
 *
 * This reproduces what three.js does (object quaternion, then translate, then the
 * perspective divide) rather than trusting a projection helper, because the point
 * of the exercise is to be independent of the renderer's own arithmetic.
 */
const GEOMETRY = `(() => {
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng) return { error: 'no engine handle' };
  const pts = eng.debugScene.points, cam = eng.debugScene.camera;
  const W = window.innerWidth, H = window.innerHeight;
  const tan = Math.tan((cam.fov * Math.PI) / 360);
  const q = pts.quaternion, ox = pts.position.x, oy = pts.position.y, oz = pts.position.z;
  const rot = (x, y, z) => {
    const ix =  q.w * x + q.y * z - q.z * y;
    const iy =  q.w * y + q.z * x - q.x * z;
    const iz =  q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    return [ ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
             iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
             iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x ];
  };
  const project = (buf) => {
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, behind = 0, n = 0;
    for (let i = 0; i < buf.length; i += 3) {
      const r = rot(buf[i], buf[i + 1], buf[i + 2]);
      const wx = r[0] + ox, wy = r[1] + oy, wz = r[2] + oz;
      const d = cam.position.z - wz;
      if (!(d > 0.001)) { behind++; continue }
      n++;
      const sx = (wx / (tan * cam.aspect * d) + 1) / 2 * W;
      const sy = (1 - wy / (tan * d)) / 2 * H;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    return { n, behind, w: maxX - minX, h: maxY - minY,
      fw: (maxX - minX) / W, fh: (maxY - minY) / H, x0: minX, x1: maxX, y0: minY, y1: maxY,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, W, H };
  };
  const live = project(pts.geometry.attributes.position.array);

  // The levelled anchor buffer: the glyph's own world box, before any particle motion.
  let anchors = null;
  try {
    const g = eng.scratch.glyphTargets;
    let aMinX = 1e9, aMaxX = -1e9, aMinY = 1e9, aMaxY = -1e9;
    for (let i = 0; i < g.length; i += 3) {
      if (g[i] < aMinX) aMinX = g[i]; if (g[i] > aMaxX) aMaxX = g[i];
      if (g[i + 1] < aMinY) aMinY = g[i + 1]; if (g[i + 1] > aMaxY) aMaxY = g[i + 1];
    }
    anchors = { worldW: aMaxX - aMinX, worldH: aMaxY - aMinY };
  } catch (e) { anchors = { error: String(e).slice(0, 120) } }

  const dz = cam.position.z - oz;
  const visH = 2 * tan * dz;
  // The particles' own distance from their anchors, in world units. Read HERE rather
  // than in a separate call because the star-flow mask is built per frame and needs the
  // spread belonging to that same instant.
  let cloudSpread = null;
  try {
    const g2 = eng.scratch.glyphTargets;
    const pos = pts.geometry.attributes.position.array;
    let maxD = 0, sum = 0, n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - g2[i], dy = pos[i + 1] - g2[i + 1], dzz = pos[i + 2] - g2[i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dzz * dzz);
      if (d > maxD) maxD = d;
      sum += d; n++;
    }
    cloudSpread = { maxAnchorDist: +maxD.toFixed(4), meanAnchorDist: +(sum / (n || 1)).toFixed(4), n };
  } catch (e) { cloudSpread = { error: String(e).slice(0, 120) } }
  // camZ / contentZ / tanHalfFov are reported separately on purpose, and the
  // fixed-world-size CONTROL is deliberately NOT computed here. See the note on
  // V3's control below: it must be a counterfactual against a frozen content
  // plane, and the frozen plane is only knowable once the sweep has started.
  return { live, anchors, cloudSpread,
    camZ: +cam.position.z.toFixed(4), contentZ: +oz.toFixed(4),
    tanHalfFov: +tan.toFixed(6), aspect: +cam.aspect.toFixed(4),
    dz: +dz.toFixed(4), visH: +visH.toFixed(4),
    fhForGlyphHeight: 10.08 / visH, fwForGlyphHeight: 10.08 / (visH * cam.aspect) };
})()`

/**
 * The fixed-world-size control, as an explicit COUNTERFACTUAL.
 *
 * The control's job is to answer "what would this frame show if the comet were
 * nailed to the world and the camera receded alone?". Its distance is therefore
 * `camZ - contentZ_PINNED`, with the content plane frozen at the z it had when the
 * sweep began — NOT `camZ - contentZ_now`.
 *
 * Reading the live content z is the bug this replaces, and it is fatal rather than
 * cosmetic: once the engine makes the content retreat with the camera (V3 itself),
 * `camZ - contentZ_now` is the constant `gap`, so the "control" collapses to a
 * single value, `corr(camZ, control)` becomes 0 by convention, and the ratio
 * `measured / control` divides by zero. A control that follows the thing it is
 * supposed to be a control for cannot fail, and a criterion that cannot fail is
 * not a criterion.
 *
 * With the plane frozen the control behaves as designed on BOTH layouts:
 *   - baseline (content nailed at SUBJECT_Z = -6): the frozen plane IS the live
 *     plane, so the control is numerically identical to the pre-fix value — the
 *     range [27.5%, 47.0%] the earlier runs recorded;
 *   - LF (content riding the dolly): the frozen plane is the sweep's starting
 *     content z, and the control now spans ~35.5%..76.2% while the measurement
 *     holds at ~76%, which is the discriminator V3 needs.
 */
function controlFhFor(frozenContentZ, sample) {
  const dz = sample.camZ - frozenContentZ
  const visH = 2 * sample.tanHalfFov * dz
  return Number.isFinite(visH) && visH > 0 ? GLYPH_WORLD_HEIGHT / visH : NaN
}

/**
 * Resolve once the choreography is in `hold` inside a progress window, so a sample
 * lands in the settled part of the phase rather than on the gather's tail end.
 */
const WAIT_HOLD = (ms, lo, hi) => `(() => new Promise((resolve) => {
  const dl = performance.now() + ${ms};
  const tick = () => {
    const eng = window.__SUB2API_PARTICLE_ENGINE__;
    const st = window.__SUB2API_PARTICLE_STATS__;
    if (st && st.phase === 'hold' && eng && eng.choreography) {
      const p = eng.choreography.state.phaseProgress;
      if (p >= ${lo} && p <= ${hi}) return resolve({ ok: true, brand: st.brandSlug, p,
        brandIndex: eng.choreography.state.brandIndex, legIndex: eng.choreography.state.legIndex });
    }
    if (performance.now() > dl) {
      return resolve({ timeout: true, phase: st ? st.phase : null,
        p: eng && eng.choreography ? eng.choreography.state.phaseProgress : null });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}))()`

/**
 * Drive the engine's own `dollySeconds` to a given point of the dolly period.
 *
 * This is how the V3 sweep covers the WHOLE period instead of whatever fraction of it
 * a few minutes of wall-clock happens to contain. `dollySeconds` is the accumulator
 * `advanceCamera()` reads, so setting it evaluates the shipped dolly function at a
 * chosen point of its domain rather than substituting a different camera. The engine
 * carries on accumulating from there.
 */
const SET_DOLLY = (seconds) => `(() => new Promise((resolve) => {
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng) return resolve({ error: 'no engine handle' });
  eng.dollySeconds = ${seconds};
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    const cam = eng.debugScene.camera;
    resolve({ ok: true, set: ${seconds}, camZ: +cam.position.z.toFixed(4) });
  })));
}))()`

/**
 * Bring a brand on screen AND wait for the cloud to actually settle onto its glyph.
 *
 * Three conditions, all necessary, and the third is the one that is easy to miss:
 *
 *  1. a `hold` in its settled window, so the phase's own easing has finished;
 *  2. the roster slot showing the brand that was asked for;
 *  3. the cloud no longer moving.
 *
 * (3) is not redundant. `nextBrand()` changes the roster, and the engine then
 * re-derives the glyph on the next frame and springs the particles across to it —
 * while the phase is still `hold`, because the phase clock knows nothing about the
 * roster. Measuring during that transit reads a cloud strung out between two shapes,
 * and the live projection and the pixels then disagree by 40% through no fault of
 * either. Convergence is therefore measured directly, as the frame-to-frame change of
 * the projected box: when it stops changing, the shape has arrived.
 */
const BRING_BRAND_SETTLED = (slug, lo, hi, attempts) => `(() => new Promise((resolve) => {
  const want = ${JSON.stringify(slug)};
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng || !eng.choreography) return resolve({ error: 'no engine handle' });

  const box = () => {
    const pts = eng.debugScene.points, cam = eng.debugScene.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const q = pts.quaternion, ox = pts.position.x, oy = pts.position.y, oz = pts.position.z;
    const pos = pts.geometry.attributes.position.array;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const ix =  q.w * x + q.y * z - q.z * y;
      const iy =  q.w * y + q.z * x - q.x * z;
      const iz =  q.w * z + q.x * y - q.y * x;
      const iw = -q.x * x - q.y * y - q.z * z;
      const rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y + ox;
      const ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z + oy;
      const rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x + oz;
      const d = cam.position.z - rz;
      if (!(d > 0.001)) continue;
      const sx = (rx / (tan * cam.aspect * d) + 1) / 2 * W;
      const sy = (1 - ry / (tan * d)) / 2 * H;
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    }
    return { w: (maxX - minX) / W, h: (maxY - minY) / H };
  };

  let round = 0, frames = 0, prev = null, stableFrames = 0;
  const beginRound = () => {
    round += 1; prev = null; stableFrames = 0;
    if (round > ${attempts}) {
      const s = window.__SUB2API_PARTICLE_STATS__;
      return resolve({ ok: false, reason: 'rounds exhausted', brand: s ? s.brandSlug : null, phase: s ? s.phase : null });
    }
    waitHold();
  };
  const waitHold = () => {
    const st = window.__SUB2API_PARTICLE_STATS__;
    if (++frames > 4000) return resolve({ ok: false, reason: 'frame budget exhausted', brand: st.brandSlug });
    const p = eng.choreography.state.phaseProgress;
    if (st.phase === 'hold' && p >= ${lo} && p <= ${hi}) return walk();
    requestAnimationFrame(waitHold);
  };
  const walk = () => {
    const s = window.__SUB2API_PARTICLE_STATS__;
    // A beat boundary during the walk means the roster moved on its own: start over.
    if (s.phase !== 'hold') return requestAnimationFrame(beginRound);
    if (s.brandSlug === want) return settle();
    eng.choreography.nextBrand();
    requestAnimationFrame(walk);
  };
  const settle = () => {
    const st = window.__SUB2API_PARTICLE_STATS__;
    if (st.phase !== 'hold') return requestAnimationFrame(beginRound);
    if (st.brandSlug !== want) return requestAnimationFrame(walk);
    const b = box();
    if (prev) {
      const dw = Math.abs(b.w - prev.w), dh = Math.abs(b.h - prev.h);
      stableFrames = (dw < 0.004 && dh < 0.004) ? stableFrames + 1 : 0;
      if (stableFrames >= 3) {
        return resolve({ ok: true, brand: st.brandSlug, round, stableFrames,
          phaseProgress: eng.choreography.state.phaseProgress,
          brandIndex: eng.choreography.state.brandIndex,
          live: { fw: +b.w.toFixed(4), fh: +b.h.toFixed(4) } });
      }
    }
    prev = b;
    if (++frames > 4000) return resolve({ ok: false, reason: 'frame budget exhausted in settle', brand: st.brandSlug });
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(waitHold);
}))()`

/**
 * Wait until the cloud has converged onto its glyph anchors.
 *
 * `nextBrand()` and a beat boundary both re-derive the glyph, and the particles then
 * take a few hundred ms to spring across to it while the phase clock still reports
 * `hold`. A sample taken in that window is a cloud strung out between two shapes: the
 * projected box grows, and the pixel route (which sees the sparse in-transit cloud)
 * reports something narrower. Requiring convergence removes that whole class of
 * spurious disagreement.
 *
 * The measure is the mean distance from each particle to its own anchor, in world
 * units, against the glyph's own 10.08-unit height — so the threshold is scale-free.
 */
const WAIT_SETTLED = (ms, maxMeanDist) => `(() => new Promise((resolve) => {
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng) return resolve({ error: 'no engine handle' });
  const dl = performance.now() + ${ms};
  const tick = () => {
    const pos = eng.debugScene.points.geometry.attributes.position.array;
    const g = eng.scratch.glyphTargets;
    let maxD = 0, sum = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - g[i], dy = pos[i + 1] - g[i + 1], dz = pos[i + 2] - g[i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxD) maxD = d;
      sum += d;
    }
    const meanD = sum / (pos.length / 3);
    const st = window.__SUB2API_PARTICLE_STATS__;
    const p = eng.choreography.state.phaseProgress;
    if ((meanD < ${maxMeanDist} && st.phase === 'hold') || performance.now() > dl) {
      return resolve({ ok: meanD < ${maxMeanDist}, meanAnchorDist: +meanD.toFixed(3),
        maxAnchorDist: +maxD.toFixed(3), phase: st.phase, phaseProgress: +p.toFixed(3), brand: st.brandSlug });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}))()`

// ---------------------------------------------------------------------------
// Verdict bookkeeping
// ---------------------------------------------------------------------------

const results = []
const measurements = {}

function record(criterion, name, pass, detail, evidence) {
  // `status` is the machine-readable form and `pass` is kept for the existing console
  // rendering. The point of the separate field: `pass === false` must mean FAILED and
  // nothing else. A skipped check previously carried `pass: null`, which is FALSY, so any
  // consumer filtering on `!v.pass` — or on `pass === false` after a coercion — read
  // "not answered" as "failed". That is the same class of mistake as the silent division
  // by zero this probe exists to correct: a value that cannot express its own state.
  const status = pass === null ? 'skip' : pass ? 'pass' : 'fail'
  const entry = { criterion, name, pass, status, detail, evidence }
  results.push(entry)
  const tag = status === 'skip' ? 'SKIP' : status === 'pass' ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${criterion} ${name} — ${detail}`)
  return status
}

/** Instrument failure is neither PASS nor FAIL: it means no answer was obtained. */
function instrumentInvalid(reason) {
  console.log('\n!!! INSTRUMENT INVALID — ' + reason)
  console.log('    (not reporting PASS or FAIL: the measurement itself is untrustworthy)')
  const error = new Error(reason)
  error.instrumentInvalid = true
  throw error // unwind scene gates before the outer runner writes the result
}

function finish(code) {
  const summary = {
    url: URL_,
    startedAt: new Date().toISOString(),
    verdicts: results,
    measurements,
    // The instrument is valid when no INSTRUMENT-criterion check FAILED. Testing for
    // the presence of such verdicts instead would report invalid on every run, since
    // the passing ones are recorded too — and this must key off `status` rather than
    // truthiness, so a skipped instrument check is never read as a failure.
    instrumentValid: !results.some((r) => r.criterion === 'INSTRUMENT' && r.status === 'fail'),
    // Explicit counts, so a consumer never has to infer them from a nullable `pass`.
    counts: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      skip: results.filter((r) => r.status === 'skip').length,
    },
    exitCode: code,
  }
  const jsonPath = join(OUT, 'framing-probe.json')
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2))

  console.log('\n=== RESULTS ===')
  const byCriterion = {}
  for (const r of results) {
    byCriterion[r.criterion] = byCriterion[r.criterion] || []
    byCriterion[r.criterion].push(r)
  }
  for (const [k, rs] of Object.entries(byCriterion)) {
    const failed = rs.filter((r) => r.status === 'fail').length
    const passed = rs.filter((r) => r.status === 'pass').length
    const skipped = rs.filter((r) => r.status === 'skip').length
    console.log(`  ${k}: ${passed} pass, ${failed} fail${skipped ? ', ' + skipped + ' skip' : ''}`)
  }
  // Skips are listed in full, by name, rather than only counted. A criterion that was
  // not answered must never be able to read as a criterion that was satisfied, which is
  // the whole reason the skip state exists here.
  const skippedChecks = results.filter((r) => r.status === 'skip')
  if (skippedChecks.length) {
    console.log(`\n  --- NOT ANSWERED (${skippedChecks.length}) — neither pass nor fail ---`)
    for (const s of skippedChecks) console.log(`  [SKIP] ${s.criterion} ${s.name}\n         ${s.detail}`)
  }
  const totalFail = summary.counts.fail
  console.log(`\n  ${totalFail === 0 ? 'ALL CHECKS PASSED' : totalFail + ' CHECK(S) FAILED'}` +
    (summary.counts.skip ? ` (${summary.counts.skip} not answered)` : ''))
  console.log(`  json: ${jsonPath}`)
  console.log(`  screenshots: ${OUT}`)
  if (chrome) chrome.kill('SIGKILL')
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Shared helpers that need CDP
// ---------------------------------------------------------------------------

async function shoot(cdp, name) {
  const png = await cdp.png()
  if (name) writeFileSync(join(OUT, name), png)
  const img = decodePng(png)
  return { img, lum: toLum(img) }
}

/**
 * V6's pixel measurement, with the scene graph gated so the frame holds the glyph
 * and nothing else.
 *
 * Returns the union bbox at several thresholds plus the component leaders. The
 * threshold sweep is not decoration: a real silhouette contracts as the threshold
 * rises, whereas a constant-width rectangle (page chrome, or a card edge) does not.
 * That difference is what separates a glyph from an artefact.
 */
async function measureGlyph(cdp, label) {
  const shot = await withSceneVisibility(cdp, true, false, async () => {
    await sleep(140)
    return shoot(cdp, label)
  })
  const thresholds = {}
  for (const thr of [16, 24, 32, 48]) {
    const b = litBbox(shot.lum, shot.img.w, shot.img.h, thr)
    thresholds[thr] = b.lit
      ? { lit: b.lit, w: b.w, h: b.h, fw: round(b.w / shot.img.w), fh: round(b.h / shot.img.h), x0: b.x0, y0: b.y0 }
      : { lit: 0 }
  }
  const comps = components(shot.lum, shot.img.w, shot.img.h, 24, 200)
  return { shot, thresholds, comps: comps.slice(0, 5), compCount: comps.length }
}

// ---------------------------------------------------------------------------
// CRITERION 0 — instrument self-proof, on known answers
// ---------------------------------------------------------------------------

/**
 * Calibrate the pixel primitive before it is used to judge anything.
 *
 * A probe that cannot be shown to read a known rectangle correctly cannot be
 * believed when it reports a glyph is 2/3 of the viewport. So: a white marker at a
 * known CSS rect must come back at that exact rect (times the device pixel ratio),
 * and with the marker gone and the scene hidden the frame must be black.
 */
async function calibrate(cdp) {
  console.log('\n=== CRITERION 0 — instrument self-proof (known answers) ===')

  await cdp.eval(ISOLATE)
  await sleep(300)

  const { calOk, blackOk, worst } = await withSceneVisibility(cdp, false, false,
    () => calibrateIsolated(cdp))
  if (!calOk || !blackOk) {
    instrumentInvalid(`calibration failed (marker error ${round(worst, 2)} px, negative control black=${blackOk})`)
  }
  console.log('  instrument validated on known answers.')
}

async function calibrateIsolated(cdp) {
  // The negative control: nothing lit must measure as nothing lit.
  await cdp.eval(MARKER(0, 0, 0, 0, false))
  await sleep(400)
  const black = await shoot(cdp, 'cal-negative-control.png')
  const litAt = {}
  for (const thr of [1, 8, 16, 32, 64]) litAt[thr] = litBbox(black.lum, black.img.w, black.img.h, thr).lit
  const blackOk = Object.values(litAt).every((v) => v === 0)
  measurements.negativeControl = { frame: { w: black.img.w, h: black.img.h }, litByThreshold: litAt }
  record('INSTRUMENT', 'negative-control black', blackOk,
    blackOk ? `frame ${black.img.w}x${black.img.h} has 0 lit px at every threshold 1..64`
            : `frame is NOT black: lit=${JSON.stringify(litAt)} — pixels are contaminated`,
    { litByThreshold: litAt })

  // Repeat-capture stability: two captures with nothing changed must match. When
  // `engine.stop()` had been called, screenshots went stale and this is the check
  // that catches it.
  const a = await shoot(cdp, null)
  await sleep(350)
  const b = await shoot(cdp, null)
  const stable = a.img.w === b.img.w && a.img.h === b.img.h

  // The known-answer measurement: three rects, corners and centre included.
  const rects = [
    { x: 0, y: 0, w: 120, h: 90 },
    { x: 240, y: 180, w: 300, h: 200 },
    { x: 37, y: 53, w: 199, h: 61 },
  ]
  const calErrors = []
  const calRows = []
  for (const r of rects) {
    await cdp.eval(MARKER(r.x, r.y, r.w, r.h, false))
    await sleep(180)
    const css = await cdp.eval(MARKER(r.x, r.y, r.w, r.h, true))
    await sleep(280)
    const shot = await shoot(cdp, null)
    // The frame is the CSS viewport scaled by the device pixel ratio, so the
    // expected bbox is the CSS rect times dpr. Getting this wrong would show up as
    // a false calibration failure on the 3x phone viewport and nowhere else.
    const dprNow = (await cdp.eval(STATE)).dpr || 1
    const measured = litBbox(shot.lum, shot.img.w, shot.img.h, 128)
    if (!measured.lit) {
      calRows.push({ rect: r, css, dpr: dprNow, measured: null, error: null })
      calErrors.push({ missing: true, rect: r })
      continue
    }
    const err = Math.max(
      Math.abs(measured.x0 - css.x * dprNow), Math.abs(measured.y0 - css.y * dprNow),
      Math.abs(measured.w - css.w * dprNow), Math.abs(measured.h - css.h * dprNow)
    )
    calErrors.push(err)
    calRows.push({
      rect: r, css, dpr: dprNow,
      measured: { x0: measured.x0, y0: measured.y0, w: measured.w, h: measured.h },
      expectedPx: { w: css.w * dprNow, h: css.h * dprNow },
      error: round(err, 2),
    })
  }
  await cdp.eval(MARKER(0, 0, 0, 0, false))

  const numeric = calErrors.filter((e) => typeof e === 'number')
  const worst = numeric.length ? Math.max(...numeric) : NaN
  const allFound = numeric.length === rects.length
  // 2 px of tolerance: the capture is at integer device pixels and a CSS rect may
  // land on a fractional boundary at dpr > 1.
  const calOk = allFound && worst <= 2
  measurements.calibration = { rects: calRows, worstAbsErrorPx: round(worst, 3), tolerancePx: 2, repeatCaptureStable: stable }
  record('INSTRUMENT', 'marker bbox accuracy', calOk,
    allFound ? `worst absolute error ${round(worst, 2)} px over ${rects.length} rects (tolerance 2 px)` :
               'at least one known rect produced no lit pixels — the pixel chain is broken',
    { worstAbsErrorPx: round(worst, 3), rows: calRows })

  // The measured frame must be the CSS viewport, so a share of the frame is a
  // share of the viewport.
  const st = await cdp.eval(STATE)
  const frameOk = black.img.w === st.iw * 1 || black.img.w === Math.round(st.iw * st.dpr)
  measurements.frameScale = { frame: { w: black.img.w, h: black.img.h }, cssViewport: { w: st.iw, h: st.ih, dpr: st.dpr } }
  record('INSTRUMENT', 'frame == viewport x dpr', frameOk,
    `frame ${black.img.w}x${black.img.h} vs CSS ${st.iw}x${st.ih}@${st.dpr}x`,
    measurements.frameScale)

  return { calOk, blackOk, worst }
}

// ---------------------------------------------------------------------------
// CRITERION 3 — V6, pattern size
// ---------------------------------------------------------------------------

/**
 * One V6 sample's verdicts.
 *
 * The two routes to the glyph's box do not measure the same thing when the glyph is
 * wider than the viewport, and conflating them produced seven spurious "routes
 * disagree" failures:
 *
 *   live    projects the whole `position` attribute, including the part off-screen.
 *           `fw` can therefore exceed 1.0 — the run measured 2.84 on 390x844.
 *   pixels  counts pixels that are actually lit, so a clipped glyph saturates at
 *           exactly 1.0 (the run measured exactly 1.0 for xiaomimimo).
 *
 * When the live box runs past the frame edge, the two CANNOT agree, and that is a
 * measurement-definition fact rather than a defect in the page. So the cross-check is
 * reported as SKIPPED for a clipped sample, and two honest, separate criteria take its
 * place: how much of the width is visible, and how far past the edge the rest goes.
 *
 * When the glyph does fit, the two routes still differ by the particle cloud's own
 * spread beyond the anchor box — measured, in world units, by `GEOMETRY.cloudSpread`. The tolerance
 * is derived from that and from the projection's scale, so a wide brand is allowed
 * more disagreement than a narrow one, for the reason that it genuinely has a wider
 * cloud. The threshold sweep contributes nothing (measured span <= 0.0023), which is
 * why it is not the source of the tolerance.
 */
async function recordV6Sample(cdp, viewport, row) {
  const live = row.live
  const th = row.pixelsThr24
  const th48 = row.pixelsThr48
  const vw = row.viewport.w
  const vh = row.viewport.h
  const spread = row.cloudSpread || {}
  const label = `${viewport.name} / ${row.brand}`

  const heightOk = live.fh >= MIN_HEIGHT_SHARE
  const widthOk = live.fw >= MIN_WIDTH_SHARE

  // Clipping: the projected box leaves the frame. `live.wPx`/`live.hPx` are CSS px.
  const overLeft = row.geoBox ? Math.max(0, -row.geoBox.x0) : 0
  const overRight = row.geoBox ? Math.max(0, row.geoBox.x1 - vw) : 0
  const overTop = row.geoBox ? Math.max(0, -row.geoBox.y0) : 0
  const overBottom = row.geoBox ? Math.max(0, row.geoBox.y1 - vh) : 0
  const overhangPx = { left: round(overLeft, 1), right: round(overRight, 1), top: round(overTop, 1), bottom: round(overBottom, 1) }
  const overhangFrac = round((overLeft + overRight) / vw, 4)
  const clipped = overLeft + overRight + overTop + overBottom > 1

  const tol = v6Tolerance(row)
  const dfw = th && th.lit ? Math.abs(th.fw - live.fw) : NaN
  const dfh = th && th.lit ? Math.abs(th.fh - live.fh) : NaN
  // The tolerance must stay a real constraint, not a rubber stamp. If it ever grows past
  // a quarter of the viewport, it would pass regardless of what the two routes said, and
  // the honest thing is to say so rather than report a meaningless PASS.
  //
  // This is a SAMPLE-local instrument limit, so it follows the same handling as the
  // clipped-glyph case below: the comparison is reported as NOT ANSWERED. That precedent
  // (`saturates` -> SKIP) is the right one here rather than an INSTRUMENT verdict, because
  // `instrumentValid` is run-global: marking the whole run untrustworthy over one sample's
  // blown tolerance would overstate the damage and manufacture a new false signal — the
  // exact class of error this change exists to remove.
  const tolNonTrivial = tol.fh < 0.25 && tol.fw < 0.25
  const withinTol = !!(th && th.lit > 0 && dfw <= tol.fw && dfh <= tol.fh)

  record('V6', `${label} height >= 66.7%`, heightOk,
    `fh=${round(live.fh)} (need >= ${round(MIN_HEIGHT_SHARE)}) ` +
    `[pixels thr24 fh=${th && th.lit ? round(th.fh) : 'n/a'}${clipped ? ', glyph clipped' : withinTol ? ', agrees' : ', differs by ' + round(dfh, 4)}]`,
    { live: row.live, pixels: th, clipped })

  record('V6', `${label} width >= 33.3%`, widthOk,
    `fw=${round(live.fw)} (need >= ${round(MIN_WIDTH_SHARE)}) ` +
    `[pixels thr24 fw=${th && th.lit ? round(th.fw) : 'n/a'}]`,
    { live: row.live, pixels: th })

  // --- the two routes, with the clipping case separated out ----------------
  if (clipped) {
    // The comparison is not merely failing here, it is UNDEFINED: the live route projects
    // the whole cloud including the part off-screen, while the pixel route can only count
    // what is drawn. Reporting that as "routes disagree" — seven times, on the earlier run
    // — attributed a measurement-definition fact to the page.
    record('V6', `${label} cross-check live vs pixels`, null,
      `SKIPPED (glyph exceeds the viewport — the comparison is not defined at this aspect): ` +
      `the live route projects the whole cloud, including the ${round(overLeft + overRight, 0)} px that fall ` +
      `outside a ${vw} px viewport, so live fw=${round(live.fw)} (${round(live.wPx)} px) while the pixel route ` +
      `can only count what is drawn and saturates at fw=${th && th.lit ? round(th.fw) : 'n/a'}. ` +
      `The two cannot agree by construction, so this is reported as SKIPPED rather than as a disagreement. ` +
      `See the two criteria below for the honest measurement of this case.`,
      { clipped, overhangPx, live: row.live, pixels: th })

    // How much of the glyph is actually ON SCREEN, as a share of the viewport width.
    //
    // This is the intersection of the projected box with the frame, which is the thing a
    // visitor can see. The first version of this line subtracted both overhangs from the
    // box's total width, double-counting the clipped parts and producing negative shares
    // (-85%) for a glyph that in fact filled its viewport edge to edge.
    //
    // Note the honest limit of this number: a box that overhangs BOTH edges saturates at
    // 1.0 by definition, so for those samples the informative quantity is the overhang
    // reported alongside, not this share. It is still worth measuring, because a
    // one-sided overhang gives a real fraction — groq's 67.8% on 390x844 against the
    // user's 33.3% floor.
    const visiblePx = Math.min(vw, row.geoBox.x1) - Math.max(0, row.geoBox.x0)
    const visibleFrac = round(Math.max(0, visiblePx) / vw, 4)
    const saturates = overLeft > 0 && overRight > 0
    // A glyph that saturates BOTH edges has no width share to measure — the honest
    // report is the overhang, as data, and the fact that the width comparison cannot be
    // made at this aspect. This is recorded as SKIPPED rather than as a PASS, because
    // `true` here would be a criterion that asserts nothing: it would pass identically
    // whether the glyph were 1.2x or 12x the viewport, which is exactly the "a criterion
    // that cannot fail is not a criterion" failure this probe exists to remove.
    if (saturates) {
      record('V6', `${label} visible width share (clipped glyph)`, null,
        `SKIPPED (glyph overhangs BOTH horizontal edges): visible share is 1.0 by definition at this ` +
        `aspect, so it cannot be compared against the ${(MIN_WIDTH_SHARE * 100).toFixed(1)}% floor. ` +
        `The measured fact is the overhang: ${(overhangFrac * 100).toFixed(1)}% of the viewport width ` +
        `(left ${overhangPx.left} px, right ${overhangPx.right} px) lies outside the frame.`,
        { visibleFrac, saturates, overhangPx, overhangFrac, liveWPx: live.wPx, vw })
    } else {
      record('V6', `${label} visible width share (clipped glyph)`, visibleFrac >= MIN_WIDTH_SHARE,
        `${(visibleFrac * 100).toFixed(1)}% of the viewport width is inside the frame ` +
        `(glyph projects ${round(live.wPx)} px wide into ${vw} px, overhang ${round(overLeft + overRight, 0)} px), ` +
        `against the user's ${(MIN_WIDTH_SHARE * 100).toFixed(1)}% width floor`,
        { visibleFrac, saturates, overhangPx, liveWPx: live.wPx, vw, floor: MIN_WIDTH_SHARE })
    }
  } else {
    // The non-clipped branch: the two routes are directly comparable, and the page-level
    // verdict is `withinTol`. The tolerance cap is NOT part of it — when the cap has blown
    // the comparison is undecided and must say so. Conflating the two turned an instrument
    // limitation into `live vs pixels — differs by ...` on a sample where both routes in
    // fact agreed.
    record('V6', `${label} cross-check live vs pixels`, tolNonTrivial ? !!withinTol : null,
      tolNonTrivial
        ? withinTol
          ? `live ${round(live.fw)}x${round(live.fh)} vs pixels ${round(th.fw)}x${round(th.fh)} ` +
            `(tolerance from measured cloud spread: fw <= ${tol.fw}, fh <= ${tol.fh}; ${tol.source})`
          : `live ${round(live.fw)}x${round(live.fh)} vs pixels ${th && th.lit ? round(th.fw) + 'x' + round(th.fh) : 'nothing lit'} ` +
            `— differs by fw ${round(dfw, 4)} / fh ${round(dfh, 4)} against a tolerance of ` +
            `fw ${tol.fw} / fh ${tol.fh}, derived as ${tol.source} = ${tol.worldBound} world units ` +
            `(measured cloud ${tol.cloudWorld} + sprite ${tol.spriteWorld})`
        : `NOT ANSWERED — the routes differ by fw ${round(dfw, 4)} / fh ${round(dfh, 4)}, which is ` +
          `WITHIN this sample's tolerance fw ${tol.fw} / fh ${tol.fh}; but that tolerance has grown past ` +
          `a quarter of the viewport, so it could not have rejected any reading and the agreement is not ` +
          `evidence of anything. Recorded as not answered rather than as a PASS (which would assert ` +
          `nothing) or as a FAIL (which would blame the page for an instrument limit); see the INSTRUMENT ` +
          `criterion above.`,
      { live: row.live, pixels: th, tolerance: tol, cloudSpread: spread, clipped, tolNonTrivial,
        withinTol, dfw: round(dfw, 4), dfh: round(dfh, 4) })
  }

  const levelled = row.anchorsWorld && Math.abs(row.anchorsWorld.worldH - GLYPH_WORLD_HEIGHT) < 0.05
  record('V6', `${label} glyph levelled to 10.08 world units`, !!levelled,
    row.anchorsWorld ? `anchor world height ${round(row.anchorsWorld.worldH)} (frozen target ${GLYPH_WORLD_HEIGHT})` : 'anchor buffer unreadable',
    row.anchorsWorld)

  // The silhouette-shrink check: a real glyph thins as the threshold rises; a
  // page rectangle would keep its width exactly.
  const th16 = row.pixelsAtOtherThresholds && row.pixelsAtOtherThresholds[16]
  const shrinkOk = th16 && th48 && th16.lit > 0 && th48.lit > 0 && th48.w <= th16.w && th48.lit < th16.lit
  record('V6', `${label} contract under rising threshold`, !!shrinkOk,
    th16 && th48 ? `width ${th16.w}px@thr16 -> ${th48.w}px@thr48, lit ${th16.lit} -> ${th48.lit}` : 'no threshold data',
    { thr16: th16, thr48: th48 })
}

/**
 * What "the two routes agree" is allowed to mean, derived from the data.
 *
 * The live route projects the whole `position` attribute; the pixel route sees the
 * drawn blobs. They therefore differ by exactly how far the cloud extends beyond the
 * glyph's anchor box, and that quantity is measured — `maxAnchorDist`, in world units,
 * read from the same instant as the sample.
 *
 * The important correction over the first attempt is the FACTOR OF TWO. A particle
 * `d` outside its anchor box does not widen the box by `d`: the box is a union over all
 * particles, so a particle that far out on the left AND another that far out on the right
 * widen the total extent by `2d`. The measured evidence is unambiguous — rebuilding the
 * residuals in world units across every unclipped sample on both branches gives
 * discrepancies of 0.09..0.61 world units against `maxAnchorDist` of 0.26..0.36, i.e.
 * consistently between 1x and 2x the per-side bound and never beyond 2x. The first
 * version used the 1x bound and so was too tight by construction, which is why openai on
 * 1440x900 exceeded it by 1.5x.
 *
 * To that world-space bound two small terms are added, both physical:
 *   - the point sprite's own radius (`pointSize`, ~0.125 world units), because a drawn
 *     blob extends half a sprite past its centre in every direction;
 *   - one pixel of raster quantisation, since the pixel route's box is on integer
 *     pixel boundaries while the projection is continuous.
 *
 * Note what this criterion IS and IS NOT. It is an instrument-consistency check: its
 * job is to catch the measurement chain breaking — the failure mode that produced the
 * constant 0.7453 this probe exists to replace. It is NOT a V3/V6 discriminator, and on
 * neither branch does it separate baseline from LF (both pass it, on both versions of
 * the tolerance). That is stated plainly rather than dressed up, and the non-triviality
 * check below keeps the bound from being widened until it means nothing.
 */
function v6Tolerance(row) {
  const gap = Number.isFinite(row.dz) && row.dz > 0 ? row.dz : null
  const visH = Number.isFinite(row.visH) && row.visH > 0 ? row.visH : null
  const spread = row.cloudSpread || {}
  const maxD = Number.isFinite(spread.maxAnchorDist) ? spread.maxAnchorDist : 0
  const aspect = row.viewport.w / row.viewport.h
  // World-space bound: both sides of the box, plus the sprite's radius.
  const worldBound = 2 * maxD + SPRITE_WORLD_RADIUS
  // Convert to viewport shares. A height share and a width share differ by the aspect.
  const shareH = visH ? worldBound / visH : 0
  const shareW = visH ? worldBound / (visH * aspect) : 0
  const rasterH = 1 / (row.viewport.h || 900)
  const rasterW = 1 / (row.viewport.w || 1440)
  return {
    fh: round(Math.max(0.005, shareH + rasterH), 4),
    fw: round(Math.max(0.005, shareW + rasterW), 4),
    worldBound: round(worldBound, 4),
    cloudWorld: round(2 * maxD, 4),
    spriteWorld: SPRITE_WORLD_RADIUS,
    maxAnchorDist: maxD, gap,
    source: 'measured cloud spread x2 (both sides of the union box) + sprite radius + 1 px raster',
  }
}

/**
 * The sprite's radius in world units, at `pointSize` 0.125 with `sizeAttenuation`.
 *
 * Only a radius enters the bound (half a sprite past each edge of the union box), and
 * the point is drawn at `pointSize` world units across, so the radius is half of it.
 * Hardcoded rather than read from the engine because the probe must not import the
 * thing it is measuring; the value is verified against the shipped palette by the
 * `pointSize` echo in the sample's evidence.
 */
const SPRITE_WORLD_RADIUS = 0.0625
async function criterionV6(cdp, viewport) {
  console.log(`\n=== CRITERION 3 — V6 pattern size @ ${viewport.name} ===`)

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.w, height: viewport.h, deviceScaleFactor: viewport.dpr, mobile: !!viewport.mobile,
  })
  await sleep(2200)
  await cdp.eval(ISOLATE)
  await sleep(300)

  const st0 = await cdp.eval(STATE)
  if (st0.__error || st0.error) {
    record('V6', `${viewport.name} engine handle`, false, `no engine on the page: ${JSON.stringify(st0)}`)
    return
  }
  const aspectOk = Math.abs(st0.aspect - st0.iw / st0.ih) < 0.01
  record('V6', `${viewport.name} engine follows viewport`, aspectOk,
    `page ${st0.iw}x${st0.ih}@${st0.dpr} camAspect=${st0.aspect} expected=${round(st0.iw / st0.ih)}`)

  // Sample the hold twice: once on a square-ish mark and once on each extreme of
  // the roster, because the height floor and the width floor bite on different
  // brands and the run is only meaningful if both are actually seen. The roster is
  // walked with `nextBrand()` rather than waited out — a lap is 336 s.
  const wants = [...EXTREME_BRANDS, ...CONTROL_BRANDS]
  const samples = []
  const seenBrands = new Set()
  const perBrand = {}

  // Start from a hold so the glyph is settled before the brand walk begins.
  const firstHold = await cdp.eval(WAIT_HOLD(60000, 0.25, 0.9))
  if (!firstHold.ok) {
    record('V6', `${viewport.name} reach a hold at all`, false, `no hold within budget: ${JSON.stringify(firstHold)}`)
    return
  }

  for (const want of wants) {
    // Enter a hold, walk the roster inside it, and wait for the cloud to stop moving
    // — see BRING_BRAND_SETTLED for why all three conditions are needed.
    const brought = await cdp.eval(BRING_BRAND_SETTLED(want, 0.3, 0.9, 4))
    if (!brought.ok) {
      record('V6', `${viewport.name} bring brand ${want} on screen`, false,
        `could not select ${want}: ${JSON.stringify(brought)}`)
      continue
    }
    if (brought.brand !== want) {
      record('V6', `${viewport.name} / ${want} brand actually selected`, false,
        `asked for ${want}, the page reports ${brought.brand}`)
      continue
    }
    const settled = brought
    seenBrands.add(settled.brand)
    await sleep(120)
    const before = await cdp.eval(STATE)
    const geom = await cdp.eval(GEOMETRY)
    const m = await measureGlyph(cdp, `v6-${viewport.name}-${settled.brand}-hold.png`)
    const after = await cdp.eval(STATE)

    const th = m.thresholds[24]
    const th48 = m.thresholds[48]
    const live = geom.live
    const camDrift = Math.abs(after.camZ - before.camZ)

    /**
     * The sample is only evidence if BOTH reads landed in `hold`.
     *
     * `BRING_BRAND_SETTLED` guarantees the cloud has stopped moving and the roster
     * shows the requested brand, but the PHASE clock is independent of both: a sample
     * taken across a beat boundary has a scatter on one side of it, and a scattered
     * pattern measures as whatever shape the particles happened to be in. The earlier
     * run recorded `phaseBefore=scatter, phaseAfter=scatter` for the 390x844 sample —
     * a pattern already broken apart — and then reported the inevitable mismatch
     * against the pixel route as "routes disagree". Retry instead.
     */
    const inHold = before.phase === 'hold' && after.phase === 'hold'
    if (!inHold) {
      const retried = await cdp.eval(BRING_BRAND_SETTLED(settled.brand, 0.3, 0.9, 2))
      if (retried.ok) {
        await sleep(120)
        const b2 = await cdp.eval(STATE)
        const g2 = await cdp.eval(GEOMETRY)
        const m2 = await measureGlyph(cdp, `v6-${viewport.name}-${settled.brand}-hold2.png`)
        const a2 = await cdp.eval(STATE)
        if (b2.phase === 'hold' && a2.phase === 'hold') {
          samples.push({
            brand: settled.brand, walkSteps: retried.round, settleStableFrames: retried.stableFrames,
            retried: true, phaseBefore: b2.phase, phaseAfter: a2.phase, phaseProgress: retried.phaseProgress,
            camZ: b2.camZ, camDrift: round(Math.abs(a2.camZ - b2.camZ)),
            viewport: { w: b2.iw, h: b2.ih, dpr: b2.dpr },
            live: { fw: round(g2.live.fw), fh: round(g2.live.fh), wPx: round(g2.live.w, 1), hPx: round(g2.live.h, 1), n: g2.live.n, behind: g2.live.behind },
            geoBox: { x0: round(g2.live.x0, 1), x1: round(g2.live.x1, 1), y0: round(g2.live.y0, 1), y1: round(g2.live.y1, 1) },
            pixelsThr24: m2.thresholds[24], pixelsThr48: m2.thresholds[48],
            pixelsAtOtherThresholds: m2.thresholds, componentCount: m2.compCount, topComponents: m2.comps,
            anchorsWorld: g2.anchors, visH: g2.visH, dz: g2.dz,
            cloudSpread: g2.cloudSpread,
            fhIfGlyphWere1008: round(g2.fhForGlyphHeight),
          })
          if (!perBrand[settled.brand]) perBrand[settled.brand] = samples[samples.length - 1]
          await recordV6Sample(cdp, viewport, samples[samples.length - 1])
          continue
        }
      }
      // Retries exhausted: this sample is SKIPPED, not a failure. A sample that could
      // not be taken in `hold` is not evidence about the pattern's size, and reporting
      // it as one would be exactly the error this criterion exists to correct.
      record('V6', `${viewport.name} / ${settled.brand} sample landed in hold`, null,
        `SKIPPED (could not settle in hold): after ${2} retries the phase was ` +
        `${before.phase} -> ${after.phase}, so the pattern was not in its settled shape. ` +
        `No size verdict is reported for this sample; it is NOT counted as a disagreement.`,
        { phaseBefore: before.phase, phaseAfter: after.phase, retries: 2 })
      samples.push({
        brand: settled.brand, phaseBefore: before.phase, phaseAfter: after.phase,
        skipped: 'could not settle in hold', camZ: before.camZ,
        live: { fw: round(live.fw), fh: round(live.fh) },
      })
      continue
    }

    const row = {
      brand: settled.brand, walkSteps: brought.round, settleStableFrames: brought.stableFrames,
      retried: false,
      phaseBefore: before.phase, phaseAfter: after.phase,
      phaseProgress: settled.phaseProgress,
      camZ: before.camZ, camDrift: round(camDrift),
      viewport: { w: before.iw, h: before.ih, dpr: before.dpr },
      live: { fw: round(live.fw), fh: round(live.fh), wPx: round(live.w, 1), hPx: round(live.h, 1), n: live.n, behind: live.behind },
      geoBox: { x0: round(live.x0, 1), x1: round(live.x1, 1), y0: round(live.y0, 1), y1: round(live.y1, 1) },
      pixelsThr24: th, pixelsThr48: th48,
      pixelsAtOtherThresholds: m.thresholds,
      componentCount: m.compCount,
      topComponents: m.comps,
      anchorsWorld: geom.anchors,
      visH: geom.visH, dz: geom.dz,
      cloudSpread: geom.cloudSpread,
      fhIfGlyphWere1008: round(geom.fhForGlyphHeight),
    }
    samples.push(row)
    if (!perBrand[settled.brand]) perBrand[settled.brand] = row
    await recordV6Sample(cdp, viewport, row)
  }

  // Both binding brands must have been seen, or the viewport's V6 result is not
  // evidence about the binding constraint.
  const sawNarrow = seenBrands.has(EXTREME_BRANDS[0])
  const sawWide = seenBrands.has(EXTREME_BRANDS[1])
  record('V6', `${viewport.name} roster extremes sampled`, sawNarrow && sawWide,
    sawNarrow && sawWide
      ? `both ${EXTREME_BRANDS[0]} (narrow, width-bound) and ${EXTREME_BRANDS[1]} (wide) were measured`
      : `missing ${!sawNarrow ? EXTREME_BRANDS[0] : ''}${!sawNarrow && !sawWide ? ' and ' : ''}${!sawWide ? EXTREME_BRANDS[1] : ''} — the binding floor was not exercised`,
    { seenBrands: Array.from(seenBrands) })

  /**
   * The best case the framing can ever offer, so the verdict does not depend on where
   * in the dolly lap the sample happened to land.
   *
   * The camera retreats for the whole session, so the glyph's projected share falls
   * across the lap. A single sample therefore reports the framing at one arbitrary
   * camera distance, and could pass or fail by luck. Driving `dollySeconds` to 0 puts
   * the camera at the near end of its travel — the largest the glyph can ever be on
   * this viewport — so a failure here fails for the whole lap.
   */
  if (samples.length > 0) {
    // A skipped sample carries no `live` box worth extrapolating from.
    const usableSamples = samples.filter((s) => !s.skipped && s.live)
    if (usableSamples.length === 0) {
      record('V6', `${viewport.name} best case (nearest camera) still clears the floors`, null,
        `SKIPPED — every sample on this viewport was skipped (no sample settled in hold), so there is no ` +
        `brand to drive the camera for.`,
        { samples })
      measurements[`v6_${viewport.name}`] = samples
      return samples
    }
    const ref = usableSamples[usableSamples.length - 1]
    const best = []
    for (const [label, seconds] of [['nearest camera (dolly=0)', 0], ['far end (dolly=150)', 150]]) {
      const moved = await cdp.eval(SET_DOLLY(seconds))
      if (moved.error) continue
      await cdp.eval(WAIT_SETTLED(8000, 1.5))
      await sleep(150)
      const st = await cdp.eval(STATE)
      const geom = await cdp.eval(GEOMETRY)
      const m = await measureGlyph(cdp, `v6-${viewport.name}-${ref.brand}-${seconds === 0 ? 'nearest' : 'far'}.png`)
      const th = m.thresholds[24]
      best.push({
        label, dollySeconds: seconds, camZ: st.camZ, brand: st.brand, phase: st.phase,
        live: { fw: round(geom.live.fw), fh: round(geom.live.fh) },
        pixels: th && th.lit ? { fw: round(th.fw), fh: round(th.fh) } : null,
      })
      console.log(`    ${label}: camZ=${st.camZ} brand=${st.brand} live fh=${round(geom.live.fh)} fw=${round(geom.live.fw)}`)
    }
    if (best.length) {
      const nearest = best[0]
      const bestHeightOk = nearest.live.fh >= MIN_HEIGHT_SHARE
      const bestWidthOk = nearest.live.fw >= MIN_WIDTH_SHARE
      record('V6', `${viewport.name} best case (nearest camera) still clears the floors`, bestHeightOk && bestWidthOk,
        `at the nearest camera (camZ ${nearest.camZ}, the largest the glyph can ever be on this viewport) ` +
        `fh=${nearest.live.fh} vs floor ${round(MIN_HEIGHT_SHARE)}, fw=${nearest.live.fw} vs floor ${round(MIN_WIDTH_SHARE)} — ` +
        `so the framing fails for the whole dolly lap, not just at this sample's camera distance`,
        best)
      measurements[`v6_${viewport.name}_extremes`] = best
    }
    // Put the camera back where the clock had it, so the next viewport starts clean.
    await cdp.eval(SET_DOLLY(0))
  }

  measurements[`v6_${viewport.name}`] = samples
  return samples
}

// ---------------------------------------------------------------------------
// CRITERION 1 — V3, the camera and the comet retreat together
// ---------------------------------------------------------------------------

/**
 * V3: the comet retreats with the camera, so its on-screen angular size holds
 * approximately constant instead of shrinking as the camera pulls away.
 *
 * A fixed world size would project to `h / (2 tan(fov/2) (camZ - SUBJECT_Z))`, which
 * falls from ~52% to ~30% of the viewport over one dolly lap. V3 asks for that not
 * to happen, so the jitter of the measured share is the verdict and the *slope
 * against camZ* is the diagnostic that says whether anything was measured at all.
 *
 * The instrument self-check is the part that keeps this from being a rubber stamp:
 * `fh` is a strict monotone function of `camZ`. If `camZ` sweeps a wide range while
 * `fh` does not move, the probe is not looking at the glyph — which is exactly how
 * the constant 0.7453 was produced — and it reports INSTRUMENT INVALID rather than
 * answering the V3 question.
 */
async function criterionV3(cdp, opts) {
  console.log('\n=== CRITERION 1 — V3 camera + comet retreat together ===' +
    (opts && opts.fault ? ` [FAULT INJECTION: ${opts.fault.label}]` : ''))

  /**
   * Falsification — pin the content plane so V3's premise is deliberately broken.
   *
   * The repaired V3 has to be shown capable of FAILING on demand, or its PASS on the LF
   * branch means nothing. The baseline is not always available to compare against, so this
   * injects the exact defect V3 exists to catch: it stops the content retreating with the
   * camera, which is what the shipped code did before the fix (`this.points.position.z`
   * nailed to `SUBJECT_Z` while `advanceCamera` moved only the camera). The override is a
   * property setter on the engine's `points.position`, so `advanceCamera`'s own write
   * lands and is then forced back — the engine is not patched, its output is.
   *
   * This is a fault INJECTOR, not a substitute camera: the dolly still runs the engine's
   * own function and camZ still sweeps, so the only thing changed is that the content no
   * longer follows. V3 must report a large jitter and a within-brand slope matching the
   * world-nailed control.
   */
  if (opts && opts.fault) {
    const injected = await cdp.eval(`(() => {
      const eng = window.__SUB2API_PARTICLE_ENGINE__;
      if (!eng) return { error: 'no engine handle' };
      const pts = eng.debugScene.points;
      const pinned = pts.position.z;
      if (pts.position.__faultPinned) return { ok: true, already: true, pinned };
      const inner = pts.position;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inner), 'z')
        || Object.getOwnPropertyDescriptor(inner, 'z');
      // Force z back to the pinned value every frame by intercepting the setter that
      // advanceCamera uses. The engine is not patched; its output is.
      Object.defineProperty(inner, 'z', {
        configurable: true,
        get() { return pinned },
        set(v) { void v; },
      });
      pts.position.__faultPinned = true;
      return { ok: true, pinned, hadDescriptor: !!descriptor };
    })()`)
    console.log(`  fault: ${JSON.stringify(injected)}`)
    record('INSTRUMENT', `fault injection applied (${opts.fault.label})`, !!injected.ok,
      injected.ok
        ? `the content plane is pinned at z=${injected.pinned}: \`advanceCamera\` still writes its own content z every ` +
          `frame and the write is discarded, so the camera retreats alone — exactly the pre-fix behaviour V3 must catch`
        : `could not inject the fault: ${JSON.stringify(injected)}`,
      injected)
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(2200)
  await cdp.eval(ISOLATE)
  await sleep(300)

  const st0 = await cdp.eval(STATE)
  if (st0.__error || st0.error) {
    record('V3', 'engine handle', false, `no engine on the page: ${JSON.stringify(st0)}`)
    return
  }

  // The dolly is a closed-form function of `dollySeconds`: 0..150 s maps the camera
  // from `DOLLY_FROM_Z` (or the framing guard, whichever is further) out to
  // `DOLLY_TO_Z`, then 2.2 s eases it back. Sampling that whole domain is the only
  // way to see the full range within a probe run — waiting out 152 s of wall-clock
  // per lap would take longer than the run has, and would still only give one lap.
  const DOLLY_PERIOD_SECONDS = 150
  const samples = []
  const holdWindow = [0.3, 0.9]
  const points = []
  const count = DOLLY_SAMPLES
  for (let i = 0; i < count; i++) points.push((DOLLY_PERIOD_SECONDS * i) / (count - 1))

  // A settled hold first, so the glyph is fully assembled before the sweep begins.
  const firstHold = await cdp.eval(WAIT_HOLD(60000, 0.3, 0.9))
  if (!firstHold.ok) {
    record('V3', 'reached a hold', false, `no hold within budget: ${JSON.stringify(firstHold)}`)
    return
  }

  const started = Date.now()
  // The content plane is frozen ONCE, before the sweep, and the control is computed
  // against it for every sample. `advanceCamera` moves `points.position.z` every
  // frame on a layout that makes the content retreat with the camera, so a control
  // read per-sample would be the live distance — a constant — and the criterion
  // would divide by zero. See `controlFhFor`.
  const planeAtSweepStart = (await cdp.eval(GEOMETRY)).contentZ
  if (!Number.isFinite(planeAtSweepStart)) {
    record('V3', 'read the frozen content plane', false,
      `the content plane's z was not a finite number (${planeAtSweepStart}) — the control cannot be formed`)
    measurements.v3 = { note: 'content plane unreadable', planeAtSweepStart }
    return
  }
  console.log(`  control: content plane frozen at z=${planeAtSweepStart} (the fixed-world-size counterfactual)`)
  for (let i = 0; i < points.length; i++) {
    const target = points[i]
    const moved = await cdp.eval(SET_DOLLY(target))
    if (moved.error) {
      record('V3', 'drive the dolly', false, JSON.stringify(moved))
      break
    }
    // Wait for this pass's own hold window. Moving the dolly does not move the phase
    // clock, so the phase is wherever it was; the wait is short.
    const held = await cdp.eval(WAIT_HOLD(20000, holdWindow[0], holdWindow[1]))
    if (!held.ok) {
      console.log(`  point ${i} (dolly=${Math.round(target)} s): no hold window (${JSON.stringify(held)}) — sampling anyway`)
    }
    // Require convergence onto the glyph. The dolly does not move the anchors, but a
    // beat boundary can arrive mid-sweep and re-derive them, and a sample taken while
    // the cloud is springing across reads a stretched shape.
    const settled = await cdp.eval(WAIT_SETTLED(6000, 1.0))
    if (!settled.ok) {
      console.log(`  point ${i}: cloud not settled (mean anchor distance ${settled.meanAnchorDist}) — recorded as unsettled`)
    }
    await sleep(120)
    const before = await cdp.eval(STATE)
    const geom = await cdp.eval(GEOMETRY)
    const m = await measureGlyph(cdp, `v3-dolly${Math.round(target)}-camZ${Math.round(before.camZ)}.png`)
    const after = await cdp.eval(STATE)
    const th = m.thresholds[24]
    // How far the cloud still is from its own glyph anchors: near zero means the
    // shape has arrived, and a large value means this sample caught it mid-transit
    // (which the pixel and live routes then disagree about). Recorded so a sample
    // that was not settled can be identified after the fact rather than trusted.
    const settleDist = await cdp.eval(`(() => {
      const eng = window.__SUB2API_PARTICLE_ENGINE__;
      const pos = eng.debugScene.points.geometry.attributes.position.array;
      const g = eng.scratch.glyphTargets;
      let maxD = 0, sum = 0;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - g[i], dy = pos[i + 1] - g[i + 1], dz = pos[i + 2] - g[i + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > maxD) maxD = d;
        sum += d;
      }
      return { maxAnchorDist: +maxD.toFixed(3), meanAnchorDist: +(sum / (pos.length / 3)).toFixed(3) };
    })()`)
    const row = {
      i, dollySecondsSet: target, brand: before.brand, camZ: before.camZ, camZaAfter: after.camZ,
      phase: before.phase, phaseProgress: before.phaseProgress,
      live: { fw: round(geom.live.fw), fh: round(geom.live.fh), wPx: round(geom.live.w, 1), hPx: round(geom.live.h, 1), n: geom.live.n },
      pixels: th,
      // What a comet of FIXED world size would project to — the counterfactual control,
      // computed against the plane frozen at the start of this sweep (see
      // `controlFhFor`), NOT against the live content z.
      fhIfFixedWorldSize: round(controlFhFor(planeAtSweepStart, geom)),
      controlFrozenPlaneZ: planeAtSweepStart,
      // The live gap, reported so the two can be told apart in the JSON: on a layout
      // where the content retreats with the camera this is near-constant, which is
      // exactly why it may not be used to form the control.
      liveGap: geom.dz,
      liveContentZ: geom.contentZ,
      anchorsWorld: geom.anchors,
      ...settleDist,
      settled: settleDist.meanAnchorDist < 1.0,
    }
    samples.push(row)
    console.log(`  dolly=${Math.round(target)}s camZ=${before.camZ} brand=${before.brand} phase=${before.phase} ` +
      `live fh=${round(geom.live.fh)} fw=${round(geom.live.fw)} px fh=${th && th.lit ? round(th.fh) : 'n/a'} ` +
      `| control fh=${row.fhIfFixedWorldSize} (frozen plane z=${planeAtSweepStart}, live gap ${geom.dz})`)
  }

  if (samples.length < 4) {
    record('V3', 'enough samples across the dolly', false,
      `only ${samples.length} usable samples in ${Math.round((Date.now() - started) / 1000)} s`)
    measurements.v3 = { samples, note: 'insufficient sampling' }
    return
  }

  const camZs = samples.map((s) => s.camZ)
  // The measured pixel route and `camZ` are paired ONLY where both exist. The old
  // `camZs.slice(0, fhs.length)` re-paired the sweep's first N camera positions with
  // whatever N measurements survived, which silently mismatches every pair after the
  // first sample that produced no lit bbox.
  const paired = samples
    .filter((s) => s.pixels && s.pixels.lit)
    .map((s) => ({ camZ: s.camZ, fh: s.pixels.fh, brand: s.brand }))
  const fhs = paired.map((p) => p.fh)
  const pairedCamZs = paired.map((p) => p.camZ)
  const fhLive = samples.map((s) => s.live.fh)
  const controlled = samples.map((s) => s.fhIfFixedWorldSize)

  const corrPixels = fhs.length >= 3 ? pearson(pairedCamZs, fhs) : null
  const corrLive = pearson(camZs, fhLive)
  const corrControl = pearson(camZs, controlled)

  const camRange = { min: round(Math.min(...camZs)), max: round(Math.max(...camZs)), span: round(Math.max(...camZs) - Math.min(...camZs)) }
  // Measured against the FROZEN content plane, so this is "how far did camZ sweep
  // relative to the plane the control is built on". On the baseline the content really
  // is nailed to that plane and this is the live camera-to-content distance ratio; on
  // a layout where the content retreats too, the LIVE distance is constant by design
  // and only this frozen-plane ratio shows that camZ moved at all.
  const dzValues = samples.map((s) => s.camZ - planeAtSweepStart)
  const distanceRatio = round(Math.max(...dzValues) / Math.min(...dzValues))
  const liveGapSpread = spread(samples.map((s) => s.liveGap))
  const windowSeconds = round((Date.now() - started) / 1000, 1)

  // The sampled sweep covers the whole dolly domain by construction: it evaluates the
  // engine's own dolly function at `count` points spanning `dollySeconds` 0..150.
  const dollyDomainCovered = true
  const controlSpreadRaw = spread(controlled)
  const controlDegenerate = !Number.isFinite(controlSpreadRaw) || controlSpreadRaw < 1e-6
  measurements.v3 = {
    samples,
    camRange,
    distanceRatio,
    sweepSeconds: windowSeconds,
    dollyPeriodSeconds: DOLLY_PERIOD_SECONDS,
    dollyDomainCovered,
    sampledDollyPoints: points,
    controlFrozenPlaneZ: planeAtSweepStart,
    controlLiveGaps: samples.map((s) => s.liveGap),
    controlDegenerate,
    jitterPixels: round(spread(fhs)),
    jitterLive: round(spread(fhLive)),
    meanFhPixels: round(mean(fhs)),
    corrCamZ_fhPixels: round(corrPixels),
    corrCamZ_fhLive: round(corrLive),
    corrCamZ_fixedWorldSizeControl: round(corrControl),
    fixedWorldSizeRangePct: [round(Math.min(...controlled) * 100, 1), round(Math.max(...controlled) * 100, 1)],
    fixedWorldSizeSpread: round(controlSpreadRaw),
    measuredRangePct: [round(Math.min(...fhs) * 100, 1), round(Math.max(...fhs) * 100, 1)],
  }

  console.log(`\n  swept dollySeconds 0..${DOLLY_PERIOD_SECONDS} (the whole period) in ${windowSeconds} s of wall-clock; ` +
    `camZ ${camRange.min}..${camRange.max}, camera-to-subject varied ${distanceRatio}x`)

  // --- the control is a counterfactual, and must be able to fail ----------
  // A control that spans nothing cannot form a ratio against the measurement, and
  // silently treating it as "no evidence against V3" is how the previous version
  // turned `5.59 / 0` into a sentence claiming 5.59% was "far below" 0%. A degenerate
  // control is therefore a FAIL of this criterion, not a pass and not an absence.
  record('V3', 'the fixed-world-size control spans a real range', !controlDegenerate,
    controlDegenerate
      ? `the control is DEGENERATE: it spans ${round(controlSpreadRaw * 100, 4)}% of itself ` +
        `(range ${measurements.v3.fixedWorldSizeRangePct[0]}%..${measurements.v3.fixedWorldSizeRangePct[1]}%) ` +
        `while camZ swept ${camRange.span} — i.e. it is a constant, so no measured/control ratio exists. ` +
        `The control is computed against the content plane frozen at z=${planeAtSweepStart}; a constant here ` +
        `means the counterfactual itself is broken and V3 cannot be judged. Reporting FAIL, not a ratio.`
      : `frozen content plane z=${planeAtSweepStart}; the control spans ` +
        `${measurements.v3.fixedWorldSizeRangePct[0]}%..${measurements.v3.fixedWorldSizeRangePct[1]}% of the ` +
        `viewport (spread ${round(controlSpreadRaw * 100, 1)}%) across camZ ${camRange.min}..${camRange.max}, ` +
        `so it is a real counterfactual against which the measurement can be compared. The live gap during the ` +
        `sweep was ${samples.map((s) => round(s.liveGap, 1)).join('/')} — a constant gap is the case this control exists for.`,
    { controlSpread: round(controlSpreadRaw), frozenPlaneZ: planeAtSweepStart, liveGaps: measurements.v3.controlLiveGaps,
      controlRangePct: measurements.v3.fixedWorldSizeRangePct })

  // --- instrument self-check, BEFORE any V3 verdict -----------------------
  // fh must respond to camZ. The control says how much it SHOULD move for a comet of
  // fixed world size; if the camera moved that far and fh barely did, either the
  // comet now follows the camera (which is V3 passing, and the response is
  // legitimately small) or the measurement is not looking at the comet. Those two
  // are distinguished by the control's own span: the comet following the camera is
  // exactly the case where the fixed-size control moves a lot and the measurement
  // does not.
  const controlSpread = controlSpreadRaw
  const measuredSpread = spread(fhs)
  const camMoved = destinationSpanOk(distanceRatio)
  // The measurement must be a real measurement: something must be lit, and the
  // measured share must not be pinned at the frame edge (which is what a chrome blob
  // produces).
  const anyLit = fhs.length === samples.length
  const notClipped = fhs.every((v) => v < 1.0)
  const selfCheckOk = camMoved && anyLit && notClipped
  record('INSTRUMENT', 'V3 measurement responds to a full-dolly sweep', selfCheckOk,
    selfCheckOk
      ? `camZ swept ${camRange.span} (${distanceRatio}x) and every one of ${fhs.length} holds produced a lit, ` +
        `unclipped bbox; measured fh ${round(Math.min(...fhs))}..${round(Math.max(...fhs))} ` +
        `vs fixed-size control ${round(Math.min(...controlled))}..${round(Math.max(...controlled))}`
      : `camZ swept ${camRange.span} (${distanceRatio}x) but lit=${anyLit} unclipped=${notClipped} — ` +
        `the probe is not measuring a comet inside the frame`,
    { camRange, distanceRatio, lit: anyLit, unclipped: notClipped, fhs })

  if (!selfCheckOk) {
    instrumentInvalid(`the V3 sweep produced no trustworthy measurement (lit=${anyLit}, unclipped=${notClipped})`)
  }

  // --- the V3 verdict itself ---------------------------------------------
  const controlJitter = controlSpread
  const jitter = measuredSpread
  const jitterOk = jitter <= MAX_JITTER
  record('V3', 'comet angular size jitter < 15%', jitterOk,
    `measured fh over ${fhs.length} dolly points: ${fhs.map((v) => round(v)).join(', ')} — ` +
    `jitter ${round(jitter * 100, 2)}% (limit ${MAX_JITTER * 100}%), camZ ${camRange.min}..${camRange.max}, ` +
    `phase(s) sampled: ${Array.from(new Set(samples.map((s) => s.phase))).join(', ')}`,
    { fhs: fhs.map((v) => round(v)), camZs, jitter: round(jitter), correlation: round(corrPixels) })

  // --- B: the response to camZ, with the brand confound removed -----------
  //
  // The sweep cannot hold the roster still: `dollySeconds` drives camZ and the beat
  // clock advances the brand in the same window, so across these 8 samples `brand` and
  // `camZ` are perfectly confounded. A plain `corr(camZ, fh)` therefore measures the
  // BRAND step (the levelled glyphs sit a few percent apart) and reports it as a
  // camera effect: on the LF run that produced `corr = 0.6879` while `fh` had moved
  // ~0.2% inside any one brand, and the whole 5% apparent trend was the
  // claude -> gemini -> grok staircase happening to line up with camZ.
  //
  // The estimator is therefore the pooled WITHIN-BRAND response, and the comparison is
  // against the control's within-brand response over the SAME grouping and the same
  // camZ steps. That ratio is the "how much did the measurement move, for how much a
  // world-nailed comet would have moved, at identical camZ" number, and it is not
  // fooled by a brand offset because each brand is demeaned out.
  // All three fits go through ONE construction path — `{ x, y, brand }` — so they
  // cannot drift apart. The earlier version built the measured fit with `camZ`/`fh`
  // key names while the estimator read `x`/`y`, which produced a perfectly good
  // `liveWithinBrand` fit alongside an all-null `measuredWithinBrand` one; the criterion
  // then read the null one and reported "NaN per world unit" as if that were a
  // measurement. One shape, one estimator, no second path to get wrong.
  const asXY = (arr, xKey, yKey) => arr.map((p) => ({ x: p[xKey], y: p[yKey], brand: p.brand }))
  const measuredFit = withinGroupSlope(asXY(paired, 'camZ', 'fh'), (p) => p.brand)
  const controlFit = withinGroupSlope(asXY(samples, 'camZ', 'fhIfFixedWorldSize'), (p) => p.brand)
  // The live route's fit, reported alongside for the record. It is built from the same
  // path as the other two; `live.fh` is nested, so it is mapped explicitly rather than
  // through `asXY`'s flat key lookup.
  const liveFit = withinGroupSlope(
    samples.map((s) => ({ x: s.camZ, y: s.live.fh, brand: s.brand })), (p) => p.brand,
  )
  const responseRatio = measuredFit.slope != null && controlFit.slope != null && controlFit.slope !== 0
    ? measuredFit.slope / controlFit.slope
    : null
  // `deconfounded` is about whether the estimator could do its job at all: at least two
  // brands each with camZ spread, and both a measured and a control slope to compare.
  // It is NOT a statement about the outcome, and it must not be true on nulls — an
  // undefined slope means the confound could not be removed, which is a FAIL with the
  // reason stated, not a silently-true precondition.
  const deconfounded = measuredFit.groupsUsed >= 2 && measuredFit.usable >= 3 &&
    Number.isFinite(measuredFit.slope) && Number.isFinite(controlFit.slope) &&
    Number.isFinite(responseRatio)
  const deconfoundedOk = deconfounded && Math.abs(responseRatio) < 0.5

  // The per-brand spread, reported so the cross-brand step can be seen as a brand
  // effect rather than taken on trust. Built from the SAME fit as the verdict, so the
  // table and the number cannot disagree — the earlier version rendered this from one
  // fit while the verdict read another, and the two then showed different camZ spans for
  // the same brand.
  const brandTable = measuredFit.perGroup.map((g) => ({
    brand: g.group, n: g.n, usable: !!g.usable, reason: g.reason,
    camZSpan: g.camZSpan, fhRange: g.yRange, fhSpreadPct: g.ySpreadPct,
  }))
  measurements.v3.brandDeconfounding = {
    measuredWithinBrand: measuredFit, controlWithinBrand: controlFit, liveWithinBrand: liveFit,
    responseRatio: round(responseRatio), deconfounded, brandTable,
    confoundNote: 'brand and camZ are perfectly confounded in this sweep; the verdict uses the ' +
      'within-brand (fixed-effects) response, not the pooled correlation',
  }
  for (const g of brandTable) {
    console.log(`  brand ${g.brand}: n=${g.n} camZ span ${g.camZSpan} | fh ${g.fhRange ? g.fhRange[0] + '..' + g.fhRange[1] : 'n/a'} ` +
      `(${g.fhSpreadPct}% of itself inside one brand)${g.usable ? '' : ' — UNUSABLE: ' + g.reason}`)
  }

  record('V3', 'fh is not the fixed-world-size function of camZ (brand de-confounded)', deconfoundedOk,
    !deconfounded
      ? `could not de-confound: ${measuredFit.groupsUsed} brand group(s) with a camZ spread ` +
        `(need >= 2 and a finite control slope). The pooled corr(camZ, fh) is ${round(corrPixels)}, ` +
        `but with brand and camZ perfectly confounded it measures the brand step, not the camera — ` +
        `reporting FAIL rather than accepting a confounded number.`
      : `within-brand fh response ${round(measuredFit.slope, 6)} per world unit of camZ vs ` +
        `${round(controlFit.slope, 6)} for a world-nailed comet over the same ${measuredFit.groupsUsed} brands ` +
        `and the same camZ steps — ratio ${round(responseRatio)} (must be < 0.5 in magnitude). ` +
        `Inside a single brand fh moves ${brandTable.map((b) => b.fhSpreadPct + '%').join('/')} while the ` +
        `cross-brand range is ${measurements.v3.measuredRangePct[0]}%..${measurements.v3.measuredRangePct[1]}%, ` +
        `which is why the pooled figure (${round(corrPixels)}) could not be used.`,
    { responseRatio: round(responseRatio), measuredWithinBrandSlope: round(measuredFit.slope, 6),
      controlWithinBrandSlope: round(controlFit.slope, 6), groupsUsed: measuredFit.groupsUsed, brandTable })

  const fhRangeRaw = Math.max(...fhs) - Math.min(...fhs)
  const fhVaries = fhRangeRaw > BRAND_STEP_MIN

  // This criterion asks a question about the sweep's spread: is it a level step BETWEEN
  // brands (a brand effect) or a sloped trend WITHIN them (a camera effect)? It can only
  // answer that if the draw actually contains a between-brand step to look at.
  //
  // It did not, on three consecutive runs: the sweep drew claude + gemini only, both
  // levelled to the same height, and the whole-sweep range was 0.006..0.0087 against this
  // criterion's own 0.01 gate — so it FAILED every time on a page that was correct, while
  // the detail text described a spread of under one percent. A criterion that is false on
  // every run is worse than a missing one: it teaches the reader to ignore the FAIL column
  // and buries any real regression. So the three outcomes are separated the same way the
  // rest of this probe separates them: no de-confounding is a FAIL (informative), a
  // spread too small to attribute to anything is NOT ANSWERED, and a spread large enough
  // to attribute is the actual PASS.
  const brandSpreadVerdict = !deconfounded ? false : fhVaries ? true : null
  record('V3', 'measured spread is a brand effect, not a camera effect', brandSpreadVerdict,
    !deconfounded
      ? `could not de-confound the sweep: ${measuredFit.groupsUsed} usable brand group(s) ` +
        `(need >= 2 with a finite control slope), so a brand effect cannot be separated from a ` +
        `camera effect at all — reporting FAIL.`
      : fhVaries
        ? `per-brand fh spread: ${brandTable.map((b) => `${b.brand} ${b.fhSpreadPct}%`).join(', ')}; ` +
          `whole-sweep range ${measurements.v3.measuredRangePct[0]}%..${measurements.v3.measuredRangePct[1]}% ` +
          `(spread ${measurements.v3.jitterPixels}%). A camera effect would show up as a sloped trend WITHIN each ` +
          `brand; a brand effect shows up as a level step BETWEEN them.`
        : `NOT ANSWERED — the sweep's whole range is ${(fhRangeRaw * 100).toFixed(2)} percentage points, under ` +
          `the ${(BRAND_STEP_MIN * 100).toFixed(2)} this criterion needs before any between-brand step can be ` +
          `attributed to a brand rather than to the camera. Per-brand spread: ` +
          `${brandTable.map((b) => `${b.brand} ${b.fhSpreadPct}%`).join(', ')} (${measuredFit.groupsUsed} brand ` +
          `group(s) drawn: ${brandTable.map((b) => b.brand).join(', ')}). With no step to attribute there is ` +
          `nothing here to confirm or deny — this is recorded as not answered, NOT as a page defect. The ` +
          `discriminating power for this question rests on the two V3 criteria recorded around it: the 15% ` +
          `jitter limit and the within-brand response ratio, both of which fail loudly on a comet that does ` +
          `not follow the camera.`,
    { brandTable, measuredRangePct: measurements.v3.measuredRangePct,
      fhRangeRaw: round(fhRangeRaw, 5), brandStepMin: BRAND_STEP_MIN, groupsDrawn: measuredFit.groupsUsed })

  // The ratio criterion.
  //
  // The copy is driven by WHICH WAY the ratio points, because the same sentence cannot
  // carry both conclusions: `ratio ~= 1` means the measurement moved exactly as much as a
  // world-nailed comet would have (so it is NOT following the camera), while `ratio << 1`
  // means it barely moved at all (so it IS). The previous wording — "measured jitter is
  // far below the control" — asserted the second reading unconditionally, which is how a
  // genuine FAIL at ratio 0.9465 came out phrased as if it had passed, and how an
  // `Infinity` from a degenerate control came out phrased as if 5.59% were below 0%.
  //
  // A degenerate control has no ratio at all, so it gets its own branch and FAILs.
  const jitterRatio = controlDegenerate ? null : jitter / controlJitter
  const jitterRatioOk = !controlDegenerate && jitterRatio < 0.5
  const ratioReading = controlDegenerate ? 'undefined (control is constant)'
    : jitterRatio >= 0.5 ? `TRACKING the control (ratio ${round(jitterRatio)} ~ 1): the measurement moved as much as a ` +
      `world-nailed comet would have, so the comet is NOT following the camera`
      : `independent of camZ (ratio ${round(jitterRatio)} << 1): the measurement held while the control would have moved`
  record('V3', 'measured jitter is well below the fixed-world-size control', jitterRatioOk,
    controlDegenerate
      ? `control degenerate — cannot form a ratio: the control spans 0 across a camZ sweep of ` +
        `${camRange.span} world units, so "measured / control" has no meaning and the criterion FAILS. ` +
        `Measured jitter was ${round(jitter * 100, 2)}%, which cannot be compared to a constant.`
      : `measured jitter ${round(jitter * 100, 2)}% vs ${round(controlJitter * 100, 2)}% for a comet of fixed world ` +
        `size — ratio ${round(jitterRatio)} (must be < 0.5 to pass). Reading: ${ratioReading}. ` +
        `The independent check on camZ gives corr(camZ, fh) = ${round(corrPixels)}.`,
    { measured: round(jitter), fixedControl: round(controlJitter), ratio: round(jitterRatio),
      ratioReading, controlDegenerate, frozenPlaneZ: planeAtSweepStart })

  // Report the sweep honestly: it covers the whole dolly DOMAIN, by driving the
  // engine's own clock, not by waiting out 152 s of wall-clock.
  record('V3', 'sweep covers the full dolly period', dollyDomainCovered,
    `evaluated the engine's own dolly function at ${points.length} points spanning its ` +
    `${DOLLY_PERIOD_SECONDS} s period (${points.map((p) => Math.round(p)).join(', ')} s), ` +
    `which produces camZ ${camRange.min}..${camRange.max}. The sweep drives ` +
    `\`engine.dollySeconds\` — the same accumulator \`advanceCamera()\` reads — so these are the ` +
    `shipped camera positions for those instants, not a substituted camera. ` +
    `Wall-clock time spent: ${windowSeconds} s (the phase clock, and therefore the comet's ` +
    `phase, advanced only that far).`,
    { sampledDollyPoints: points, camRange, distanceRatio, sweepSeconds: windowSeconds })
}

/**
 * The fewest matched stars a median radial drift can be computed from.
 *
 * This is a floor on the ESTIMATOR's validity rather than a signal threshold, which is
 * why it is a small number and why it does not scale with the noise. A median is an order
 * statistic: with a handful of samples it stops being robust and becomes "whichever pair
 * happened to match", and a single mis-matched pair contributes its full displacement.
 * Eight is the conventional minimum for a sample median to be worth quoting at all.
 *
 * The signal-side requirement is separate and IS derived from the data each run — see
 * the floor computed from the zero-displacement noise and 2 * se(median) in criterionV5.
 * Conflating the two, as an earlier version did, lets a small sample masquerade as a weak
 * signal and reject a median sitting well clear of the noise.
 */
const MIN_MATCHED_STARS = 8

/** The dolly spans 15..34 world units, so more than a 1.5x change is a real sweep. */
function destinationSpanOk(ratio) {
  return Number.isFinite(ratio) && ratio >= 1.5
}

// ---------------------------------------------------------------------------
// CRITERION 2 — V5, the camera keeps retreating after the glyph re-forms
// ---------------------------------------------------------------------------

/**
 * V5: after the particles re-gather into a comet, the camera is still retreating.
 *
 * Two independent readings, and the direction convention matters, so it is stated
 * plainly rather than assumed:
 *
 *  1. `camZ` sampled once a second across more than a beat must rise monotonically,
 *     through scatter -> travel -> gather -> hold, with the only permitted
 *     exception being the dolly's own eased wrap at the end of its period.
 *
 *  2. The background stars must show the parallax that a receding camera produces.
 *     The signature is CONVERGENCE TOWARD THE VANISHING POINT — a star's screen
 *     radius is `lateral / distance` and the distance is growing — which
 *     `starfield.ts` itself describes: "translating backwards makes everything
 *     drift toward the vanishing point, which is exactly what 镜头不断拉远 should
 *     look like".
 *
 *     Note this is INWARD, not outward. A camera pulling away from a field of
 *     objects all of which are IN FRONT of it makes them crowd the centre of the
 *     frame; only objects swept past the camera would move outward, and the near
 *     band starts 60 units ahead and is recycled before it reaches the lens. The
 *     probe therefore tests the sign that the projection actually implies, and
 *     reports it explicitly so the convention can be checked rather than trusted.
 *
 * The radial component of each star's displacement is the measurement, and it is
 * deliberately a *radial projection*: each star layer also spins about the view
 * axis, and a spin moves stars tangentially, which projects to zero onto the radial
 * direction. Taking the radial component is what filters the spin out.
 */
async function criterionV5(cdp, opts) {
  console.log('\n=== CRITERION 2 — V5 camera still retreating after the glyph re-forms ===')

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(2000)
  await cdp.eval(ISOLATE)
  await sleep(300)

  const st0 = await cdp.eval(STATE)
  if (st0.__error || st0.error) {
    record('V5', 'engine handle', false, `no engine on the page: ${JSON.stringify(st0)}`)
    return
  }

  // --- 1. camZ monotonicity across more than one beat ---------------------
  const seriesMs = V5_SERIES_MS
  const series = []
  const t0 = Date.now()
  while (Date.now() - t0 < seriesMs) {
    const s = await cdp.eval(STATE)
    series.push({ t: round((Date.now() - t0) / 1000, 2), camZ: s.camZ, phase: s.phase, brand: s.brand })
    await sleep(1000)
  }
  const phasesSeen = Array.from(new Set(series.map((s) => s.phase)))
  let increases = 0
  let decreases = 0
  const drops = []
  for (let i = 1; i < series.length; i++) {
    const d = series[i].camZ - series[i - 1].camZ
    if (d > 0) increases++
    else if (d < 0) { decreases++; drops.push({ from: series[i - 1], to: series[i], delta: round(d) }) }
  }
  // The dolly wraps 34 -> 15 once per period. A single big drop is the wrap; more
  // than one, or a drop that is not the wrap, would mean the retreat is not
  // monotone.
  const wrapCandidates = drops.filter((d) => d.delta <= -5)
  const nonWrapDrops = drops.filter((d) => d.delta > -5)
  const monotoneOk = nonWrapDrops.length === 0 && wrapCandidates.length <= 1
  const sawPostScatter = phasesSeen.includes('scatter') && phasesSeen.includes('travel')

  measurements.v5 = {
    series,
    phasesSeen,
    increases,
    decreases,
    wrapCandidates,
    nonWrapDrops,
    seriesMs,
    camZRange: { min: round(Math.min(...series.map((s) => s.camZ))), max: round(Math.max(...series.map((s) => s.camZ))) },
  }

  record('V5', 'camZ rises monotonically across the beat', monotoneOk,
    `${increases} rises, ${nonWrapDrops.length} unexpected falls, ${wrapCandidates.length} dolly wrap(s) ` +
    `over ${series.length} samples in ${round(seriesMs / 1000)} s; camZ ${measurements.v5.camZRange.min}..${measurements.v5.camZRange.max}`,
    { increases, decreases, drops })

  record('V5', 'the sample window spans a scatter and a re-gather', sawPostScatter,
    `phases seen: ${phasesSeen.join(', ')}`,
    { phasesSeen })

  // The camera must still be moving AFTER the glyph re-forms, not only before it.
  // Compare the rise measured while `travel` follows a `scatter`.
  const postRegatherRises = series
    .map((s, i) => ({ s, prev: series[i - 1], i }))
    .filter((x) => x.prev && x.s.phase === 'travel' && x.s.camZ > x.prev.camZ)
  const postScatterMotion = postRegatherRises.length > 0
  record('V5', 'camera moves after re-forming into a comet', postScatterMotion,
    postScatterMotion
      ? `${postRegatherRises.length} samples where camZ rose during a travel phase that followed the glyph`
      : 'camZ never rose during a travel phase — the retreat stops when the comet re-forms',
    { postRegatherRises: postRegatherRises.slice(0, 8) })

  // --- 2. radial flow of the background, at several phases ---------------
  // Keep the existing two-frame mask and estimator; remove comet render objects
  // from its input, including tails that extend beyond the glyph-only mask.
  await withSceneVisibility(cdp, false, true, () => measureStarFlow(cdp))
}

async function measureStarFlow(cdp) {
  await sleep(300)

  /**
   * The zero-displacement noise floor, measured rather than assumed.
   *
   * Two captures taken back to back with the camera effectively frozen hold every
   * source of apparent motion except the camera's: star twinkle, sub-pixel resampling,
   * spin, and the matching algorithm's own error. Whatever median drift that pair
   * produces IS the noise, so the threshold for "the stars really moved inward" can be
   * derived as a multiple of it instead of being a hardcoded 0.02 px that the earlier
   * version applied to a 0.03 px signal.
   *
   * The camera cannot be frozen without substituting a different camera, so the pair
   * is taken over the shortest window the engine will give: two captures in the same
   * frame-ish instant. The dolly moves ~0.3 camZ/s, so a ~0.2 s gap is ~0.06 units —
   * two orders of magnitude below the 0.92-unit step the real runs use.
   */
  const noiseAState = await cdp.eval(STATE)
  const noiseGeomA = await cdp.eval(GEOMETRY)
  const noiseA = await shoot(cdp, 'v5-noise-a.png')
  const noiseGeomB = await cdp.eval(GEOMETRY)
  const noiseB = await shoot(cdp, 'v5-noise-b.png')
  const noiseBState = await cdp.eval(STATE)
  const noiseMask = buildFlowMask([noiseA, noiseB], [noiseGeomA, noiseGeomB])
  const noiseRun = radialFlow(noiseA, noiseB, {
    thr: 60, minSize: 2, maxSize: 200, matchRadius: 7, exclude: noiseMask.exclude,
  })
  const noiseFloor = Number.isFinite(noiseRun.medianRadial) ? Math.abs(noiseRun.medianRadial) : NaN
  console.log(`  noise floor: two captures 0 s apart, dz=${round(noiseBState.camZ - noiseAState.camZ)} -> ` +
    `median ${noiseRun.medianRadial} px over ${noiseRun.matched} matched stars (se ${noiseRun.seMedian}), ` +
    `mask ${noiseMask.count} px = ${(noiseMask.frameFrac * 100).toFixed(1)}% of the frame, ` +
    `unmasked ${noiseRun.candidatesUnmaskedA} candidates of which ${noiseRun.candidatesInPatternBoxA} fall in the comet box`)

  const flowRuns = []
  for (const phase of ['scatter', 'travel', 'gather']) {
    const got = await cdp.eval(`(() => new Promise((resolve) => {
      const dl = performance.now() + 45000;
      const tick = () => {
        const st = window.__SUB2API_PARTICLE_STATS__;
        if (st && st.phase === '${phase}') return resolve({ ok: true, brand: st.brandSlug });
        if (performance.now() > dl) return resolve({ timeout: true, phase: st ? st.phase : null });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }))()`)
    if (!got.ok) { flowRuns.push({ phase, error: 'phase not reached: ' + JSON.stringify(got) }); continue }

    const aState = await cdp.eval(STATE)
    // The comet's own projected footprint, masked out of the star detection. Its
    // particle gaps are small bright connected components too, and once V6's floors
    // force the glyph large they outnumber the real stars several-fold.
    //
    // The mask needs BOTH frames' footprints, not just the first: the comet patrols and
    // its head moves several world units during the 7 s window, so frame B's cloud lands
    // largely outside frame A's box. Masking only A leaves frame B's fragments in the
    // candidate set, where they get matched to frame A's completely different fragments
    // and produce a large, meaningless "drift" — the LF run's scatter sample read
    // +4.96 px, against -1.12 px on the baseline, from exactly this.
    const aGeom = await cdp.eval(GEOMETRY)
    const a = await shoot(cdp, `v5-flow-${phase}-a.png`)
    await sleep(7000)
    const bGeom = await cdp.eval(GEOMETRY)
    const b = await shoot(cdp, `v5-flow-${phase}-b.png`)
    const bState = await cdp.eval(STATE)
    const mask = buildFlowMask([a, b], [aGeom, bGeom])
    if (mask.reason) console.log(`  flow ${phase}: no usable mask (${mask.reason}) — the comet's own fragments are in the field`)

    const run = radialFlow(a, b, {
      thr: 60, minSize: 2, maxSize: 200, matchRadius: 7, exclude: mask.exclude, boxes: mask.boxes,
    })
    const dz = round(bState.camZ - aState.camZ)
    const med = run.medianRadial
    // When is the median a measurement rather than a coin flip? Two things are needed,
    // and neither is a made-up constant:
    //
    //  1. ENOUGH STARS FOR A MEDIAN TO MEAN ANYTHING. `MIN_MATCHED_STARS` is justified by
    //     the statistic, not by taste: a median of a handful of blobs is not robust, and
    //     below about eight the order statistic is dominated by whichever single pair
    //     happened to match. This is a floor on the estimator's validity, not a signal
    //     threshold.
    //  2. A SIGNAL BIGGER THAN ITS OWN UNCERTAINTY. The floor is `max(measured noise,
    //     2 * se(median))`, where the noise comes from the zero-displacement capture pair
    //     and `se = 1.253 * sigmaRobust / sqrt(n)`. So the median has to clear both what
    //     a frozen camera produces and twice its own standard error.
    //
    // An earlier version additionally required `n >= (1.253*sigma/(0.5*floor))^2`, which
    // on this data demanded 24 stars for a median sitting 3.8x above the floor — it was
    // rejecting a resolvable signal as "too few stars", conflating a weak signal with a
    // small sample. The stars needed for a 2x margin are still computed and reported as
    // `starsForTwoSigmaMargin`, so the information is on the record without being a gate.
    const sigma = Number.isFinite(run.sigmaRobust) ? run.sigmaRobust : NaN
    const starsForTwoSigmaMargin = Number.isFinite(sigma) && Number.isFinite(noiseFloor) && noiseFloor > 0
      ? Math.ceil(Math.pow((1.253 * sigma) / (noiseFloor * 0.5), 2))
      : null
    const floor = Math.max(
      Number.isFinite(noiseFloor) ? noiseFloor : 0,
      Number.isFinite(run.seMedian) ? 2 * run.seMedian : 0,
    )
    const enoughStars = run.matched >= MIN_MATCHED_STARS
    const resolved = enoughStars && dz > 0.2 && Number.isFinite(med) && Math.abs(med) > floor
    const direction = !resolved
      ? (!enoughStars ? `too few stars (${run.matched} matched, median of fewer than ${MIN_MATCHED_STARS} is not robust) — inconclusive`
        : dz <= 0.2 ? 'camera did not move' : 'within the noise floor — inconclusive')
      : med < 0 ? 'inward (toward vanishing point)' : 'outward'
    flowRuns.push({
      phase, brand: aState.brand, camZFrom: aState.camZ, camZTo: bState.camZ, dz,
      ...run,
      maskPixels: mask.count, maskFrameFrac: mask.frameFrac, maskMarginPx: mask.marginPx,
      maskBoxes: mask.boxes, maskParts: mask.parts,
      noiseFloorPx: round(floor), rawNoiseFloorPx: round(noiseFloor),
      requiredStars: MIN_MATCHED_STARS,
      starsForTwoSigmaMargin,
      decisionThresholdPx: round(floor),
      resolved, direction,
      // Kept for the record: what the old mean-based statistic says on the same data.
      wouldVoteByMeanOldRule: Number.isFinite(run.meanRadial) && run.meanRadial < -0.02,
    })
    console.log(`  flow ${phase}: dz=${dz} cand ${run.candidatesA}->${run.candidatesB} ` +
      `(mask ${(mask.frameFrac * 100).toFixed(1)}% of frame; ${run.candidatesInPatternBoxA}/${run.candidatesUnmaskedA} unmasked candidates were comet fragments) ` +
      `matched=${run.matched} median=${run.medianRadial} mean=${round(run.meanRadial, 3)} ` +
      `floor=${round(floor, 3)} -> ${flowRuns[flowRuns.length - 1].direction}`)
  }
  measurements.v5.flowRuns = flowRuns
  measurements.v5.flowNoiseFloor = {
    runs: [noiseRun], medianPx: noiseRun.medianRadial, seMedianPx: noiseRun.seMedian,
    camZDrift: round(noiseBState.camZ - noiseAState.camZ),
    maskPixels: noiseMask.count, maskFrameFrac: noiseMask.frameFrac,
    note: 'two captures taken as close together as the probe can manage; the dolly still moves ~0.06 ' +
      'world units in that gap, so this is an upper bound on the true zero-displacement noise',
  }
  // The per-run sample floor, with its formula, so the bar can be checked rather than
  // trusted. `se(median) = 1.253 * sigma / sqrt(n)`; requiring the expected signal to
  // exceed half the measured floor gives n >= (1.253 * sigma / (0.5 * floor))^2.
  measurements.v5.flowSampleFloor = {
    formula: 'n >= (1.253 * sigmaRobust / (0.5 * noiseFloorPx))^2, floored at 8',
    perRun: flowRuns.filter((r) => typeof r.requiredStars === 'number').map((r) => ({
      phase: r.phase, matched: r.matched, requiredStars: r.requiredStars,
      sigmaRobust: r.sigmaRobust, noiseFloorPx: r.rawNoiseFloorPx, starved: r.matched < r.requiredStars,
    })),
  }

  const usable = flowRuns.filter((r) => typeof r.matched === 'number' && r.dz > 0.2)
  if (usable.length === 0) {
    instrumentInvalid(
      `no usable background-flow run (need a camera step dz > 0.2; got ` +
      `${JSON.stringify(flowRuns.map((r) => ({ phase: r.phase, matched: r.matched, dz: r.dz, error: r.error })))})`
    )
  }

  const resolvedRuns = usable.filter((r) => r.resolved)
  const inconclusiveRuns = usable.filter((r) => !r.resolved)
  const inwardRuns = resolvedRuns.filter((r) => r.medianRadial < 0)
  const starPoor = usable.filter((r) => r.matched < (r.requiredStars || 8))

  /**
   * The star-flow criterion, and the tension it sits in.
   *
   * V6 requires the glyph to be at least two thirds of the viewport tall, and a glyph
   * that large COVERS the sky — on the LF layout the pattern occupied 76..80% of the
   * viewport height and the measured field was mostly its own particle fragments. So the
   * two requirements are in direct conflict by construction, and a star-flow measurement
   * taken on a V6-passing layout has fewer real stars available, a higher noise floor,
   * and less of the frame left to measure them in.
   *
   * That is why this criterion can come back INCONCLUSIVE instead of guessing. The
   * corroboration it depends on is real and independent: V5's other three criteria
   * (camZ rising monotonically across the beat, the window spanning a scatter and a
   * re-gather, and camZ still rising after the comet re-forms) answer the actual question
   * — "does the camera keep retreating after the glyph re-forms?" — from the camera
   * itself rather than from the sky, and they are reported separately above. When this
   * one is inconclusive the summary says so in words, and the V5 verdict rests on those
   * three rather than on a median taken from a handful of contaminated blobs.
   */
  record('V5', 'background stars converge toward the vanishing point (camera receding)',
    resolvedRuns.length === 0 ? null : inwardRuns.length > resolvedRuns.length / 2,
    resolvedRuns.length === 0
      ? `INCONCLUSIVE — no run produced a median radial drift that both clears its noise floor and rests on ` +
        `enough stars. Runs: ${usable.map((r) => `${r.phase} median ${r.medianRadial} px over ${r.matched} matched ` +
          `(needs ${r.requiredStars}), floor ${r.noiseFloorPx} px`).join('; ')}. The comet's own projected ` +
        `footprint occupies ${usable.map((r) => (r.maskFrameFrac * 100).toFixed(0) + '%').join('/')} of the frame and ` +
        `the unmasked candidate field was ${usable.map((r) => (r.candidatesInPatternBoxA + '/' + r.candidatesUnmaskedA)).join(', ')}, i.e. most detected blobs were the ` +
        `comet rather than sky — a direct consequence of V6's "glyph at least 2/3 of the viewport" floor, which ` +
        `necessarily hides the starfield this criterion reads. Recorded as INCONCLUSIVE, NOT as a pass and NOT as ` +
        `a failure: V5's three independent criteria (camZ monotone, window spans scatter+gather, motion after ` +
        `re-forming) are reported separately and are what the V5 verdict rests on.`
      : `${inwardRuns.length}/${resolvedRuns.length} resolved runs have a negative MEDIAN radial drift ` +
        `(inward = receding), medians ${resolvedRuns.map((r) => `${r.phase} ${r.medianRadial} px`).join(', ')} ` +
        `over ${resolvedRuns.map((r) => round(r.matched)).join('/')} matched stars (required ` +
        `${resolvedRuns.map((r) => r.requiredStars).join('/')}), against a noise floor of ` +
        `${round(resolvedRuns[0].noiseFloorPx, 3)} px` +
        (inconclusiveRuns.length ? ` (${inconclusiveRuns.length} further run(s) inconclusive: ` +
          `${inconclusiveRuns.map((r) => `${r.phase} ${r.medianRadial} px`).join(', ')})` : '') + `.`,
    { resolved: resolvedRuns.map((r) => ({ phase: r.phase, dz: r.dz, matched: r.matched, requiredStars: r.requiredStars,
      medianRadial: r.medianRadial, meanRadial: round(r.meanRadial, 4), seMedian: r.seMedian, floorPx: r.noiseFloorPx,
      inPatternBoxA: r.candidatesInPatternBoxA, unmaskedA: r.candidatesUnmaskedA, maskFrameFrac: r.maskFrameFrac })),
      inconclusive: inconclusiveRuns.map((r) => ({ phase: r.phase, matched: r.matched, requiredStars: r.requiredStars,
        medianRadial: r.medianRadial, floorPx: r.noiseFloorPx, inPatternBoxA: r.candidatesInPatternBoxA, unmaskedA: r.candidatesUnmaskedA, direction: r.direction })),
      starPoorRuns: starPoor.length })

  const magnitudesSane = resolvedRuns.length === 0 ||
    resolvedRuns.every((r) => Math.abs(r.medianRadial) < 60)
  record('V5', 'flow magnitude is consistent with the camera step', magnitudesSane,
    `median inward drift ${resolvedRuns.length ? round(mean(resolvedRuns.map((r) => r.medianRadial)), 3) : 'n/a'} px ` +
    `for a camZ step of ${usable.map((r) => round(r.dz, 2)).join('/')} world units — a star's screen radius scales as ` +
    `1/distance, so a sub-1% distance change gives a few px at most. ` +
    (resolvedRuns.length === 0 ? 'No resolved run, so there is no magnitude to bound.' : ''),
    { dz: usable.map((r) => r.dz), medianRadial: usable.map((r) => r.medianRadial) })
}

/**
 * Track small bright blobs between two frames and return the radial component of
 * each match's motion, positive outward from the frame centre.
 *
 * Nearest-neighbour matching only, within `matchRadius`, which keeps a match honest:
 * a star whose partner cannot be found inside that radius contributes nothing rather
 * than contributing a wrong pair. Stars are small connected components; anything
 * larger than `maxSize` is the comet and is skipped.
 *
 * Three things make this robust enough for a SUB-PIXEL signal, and all three are
 * load-bearing rather than refinements:
 *
 *  - `mask` excludes the pattern's own projected box. Once the glyph is drawn large
 *    (V6 asks for it to be at least two thirds of the viewport), the gaps between its
 *    particles are small bright connected components too, and they outnumbered the
 *    real stars by 3:1 on the LF run (candidates 2167 -> 6000, matched 212 -> 1599).
 *    Those fragments do not move radially from the frame centre, so leaving them in
 *    does not merely add noise, it lets the noise decide the sign.
 *  - the summary statistic is the MEDIAN, not the mean. The real displacement over a
 *    7 s window is 0.03..0.25 px, so one mis-matched pair at 7 px moves the mean by
 *    more than the entire signal. The mean is still reported for comparison.
 *  - `minRadiusFrac` restricts matching to the outer field. The radial displacement
 *    is `dr = -r * dz / d`, so it grows with screen radius: the outermost stars carry
 *    the most signal per pixel of noise, and they are also the ones the comet's
 *    bbox mask cannot touch.
 *
 * The returned `seMedian` is the standard error of that median (`1.253 * sigma /
 * sqrt(n)` with a robust MAD-based sigma). It is the noise floor the caller derives
 * its threshold from, so the caller never has to hardcode what "enough" means.
 */
function radialFlow(a, b, { thr = 60, minSize = 2, maxSize = 200, matchRadius = 7,
  minRadiusFrac = 0.35, exclude = null, boxes = null } = {}) {
  const c = (s) => ({ x: s.img.w / 2, y: s.img.h / 2 })
  const ca = c(a), cb = c(b)
  const detA = detectStars(a.lum, a.img, thr, maxSize, { minSize, exclude })
  const detB = detectStars(b.lum, b.img, thr, maxSize, { minSize, exclude })
  const minR = minRadiusFrac * Math.hypot(a.img.w / 2, a.img.h / 2)
  const moves = []
  for (const p of detA.pts) {
    let best = null, bestD = 1e9
    for (const q of detB.pts) {
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < bestD) { bestD = d; best = q }
    }
    if (!best || bestD > matchRadius) continue
    const rx = p.x - ca.x, ry = p.y - ca.y
    const r = Math.hypot(rx, ry)
    if (r < minR) continue
    const rad = (best.x - p.x) * (rx / r) + (best.y - p.y) * (ry / r)
    moves.push({ r: round(r, 1), radial: round(rad, 3), matched: round(bestD, 2), peak: p.peak })
  }
  const radial = moves.map((m) => m.radial).sort((x, y) => x - y)
  const med = radial.length ? median(radial) : NaN
  // Robust sigma from the median absolute deviation, so a handful of wrong pairs
  // inflate the noise floor by a little rather than by a factor of ten.
  const mad = radial.length ? median(radial.map((v) => Math.abs(v - med))) : NaN
  const sigma = Number.isFinite(mad) ? 1.4826 * mad : NaN
  const seMedian = Number.isFinite(sigma) && radial.length ? (1.253 * sigma) / Math.sqrt(radial.length) : NaN
  const q = (frac) => (radial.length ? radial[Math.min(radial.length - 1, Math.max(0, Math.round(frac * (radial.length - 1))))] : NaN)
  // The answer to "are these candidates even stars?", measured rather than assumed: a
  // second scan with the mask OFF, counting how many candidate centroids fall inside the
  // comet's projected box. Without this number, a field of comet fragments and a field of
  // stars look identical in the summary.
  let insideBoxA = null, candidatesRawA = null
  if (boxes && boxes.length) {
    const raw = detectStars(a.lum, a.img, thr, maxSize, { minSize, boxes })
    insideBoxA = raw.inPatternBox
    candidatesRawA = raw.pts.length + raw.inPatternBox
  }
  return {
    candidatesA: detA.pts.length, candidatesB: detB.pts.length,
    candidatesUnmaskedA: candidatesRawA, candidatesInPatternBoxA: insideBoxA,
    inPatternBoxFracA: candidatesRawA ? round(insideBoxA / candidatesRawA, 4) : null,
    maskedOutA: detA.maskedOut, inPatternBoxA: detA.inPatternBox, rejectedByShapeA: detA.rejectedByShape,
    componentCapReachedA: detA.hitCap,
    matched: moves.length,
    minRadiusPx: round(minR, 1),
    inward: radial.filter((v) => v < -0.05).length,
    outward: radial.filter((v) => v > 0.05).length,
    meanRadial: radial.length ? mean(radial) : NaN,
    medianRadial: round(med, 4),
    sigmaRobust: round(sigma, 4),
    seMedian: round(seMedian, 4),
    p25: round(q(0.25), 4), p75: round(q(0.75), 4),
    sample: moves.slice(0, 12),
  }
}

/** Median of an already-sorted numeric array. NaN for an empty one. */
function median(sorted) {
  if (!sorted.length) return NaN
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

/**
 * Small bright connected components — the stars, with the comet excluded by size.
 *
 * `exclude` is the pre-built pixel map for the comet's own footprint across BOTH
 * captured frames (see `buildFlowMask`). Components whose centroid falls inside the
 * caller's box list are counted in `inPatternBox` and reported, so the question "are the
 * candidates even stars?" has a number attached to it instead of an assumption.
 *
 * `minSize` drops single-pixel speckle, which at this threshold is mostly antialiasing
 * rather than a star.
 */
function detectStars(lum, img, thr, maxSize, { minSize = 2, exclude = null, boxes = null } = {}) {
  const comps = components(lum, img.w, img.h, thr, 6000, exclude)
  const pts = []
  let maskedOut = 0, rejectedByShape = 0, inPatternBox = 0
  for (const c of comps) {
    if (c.size > maxSize || c.size < minSize) { rejectedByShape++; continue }
    let sx = 0, sy = 0, sw = 0, peak = 0
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const l = lum[y * img.w + x]
        if (l < thr) continue
        if (l > peak) peak = l
        sx += x * l; sy += y * l; sw += l
      }
    }
    if (sw <= 0) { rejectedByShape++; continue }
    const cx = sx / sw, cy = sy / sw
    if (boxes && boxes.some((b) => b && cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1)) { inPatternBox++; continue }
    pts.push({ x: cx, y: cy, size: c.size, peak })
  }
  return { pts, compCount: comps.length, maskedOut, inPatternBox, rejectedByShape, hitCap: !!comps.hitCap }
}

// ---------------------------------------------------------------------------
// CRITERION 5b — V7 silhouette, measured in the browser
// ---------------------------------------------------------------------------

/**
 * Rasterise `claude.svg` and `anthropic.svg` into occupancy grids and compare them.
 *
 * The file-level check proves the shipped bytes are the lobehub Claude drawing. This
 * one proves the two drawings are *visibly* different, which is the user's actual
 * complaint ("Claude的logo做错了…你做的这个Anthropic的logo是错的"). A hash comparison
 * answers "same file"; an occupancy IoU answers "same shape", and it is the second
 * question the user was asking.
 *
 * Recorded reference IoUs from the recon run, as a sanity window: claude vs anthropic
 * 0.409, claude vs openai 0.400, claude vs groq 0.332, claude vs xiaomimimo 0.252.
 * Anything at or above ~0.9 would mean the same mark.
 */
const MASK_GRID = (url, N) => `(async () => {
  const img = new Image();
  const loaded = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = ${JSON.stringify(url)}; });
  if (!loaded || !img.naturalWidth) return { error: 'load failed for ' + ${JSON.stringify(url)} };
  const c = document.createElement('canvas'); c.width = ${N}; c.height = ${N};
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, ${N}, ${N});
  ctx.drawImage(img, 0, 0, ${N}, ${N});
  const d = ctx.getImageData(0, 0, ${N}, ${N}).data;
  const grid = new Array(${N} * ${N});
  let lit = 0;
  for (let i = 0; i < grid.length; i++) { const a = d[i * 4 + 3]; grid[i] = a > 64 ? 1 : 0; if (grid[i]) lit++ }
  return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, grid, lit, N: ${N} };
})()`

/** Intersection over union of two 0/1 grids. -1 when either is empty. */
function iou(a, b) {
  let inter = 0, uni = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0
    const y = b[i] ? 1 : 0
    if (x & y) inter++
    if (x | y) uni++
  }
  return uni === 0 ? -1 : inter / uni
}

async function criterionV7browser(cdp) {
  console.log('\n=== CRITERION 5b — V7 silhouette distinguishable from Anthropic\'s ===')
  const N = 32
  const refs = {}
  const sources = {
    'claude (shipped)': '/src/features/home-particle/assets/brands/claude.svg',
    'claude (lobehub)': '/node_modules/@lobehub/icons-static-svg/icons/claude.svg',
    'anthropic': '/node_modules/@lobehub/icons-static-svg/icons/anthropic.svg',
    'openai': '/src/features/home-particle/assets/brands/openai.svg',
    'groq': '/src/features/home-particle/assets/brands/groq.svg',
  }
  for (const [name, url] of Object.entries(sources)) {
    const g = await cdp.eval(MASK_GRID(url, N))
    refs[name] = g
    console.log(`  rasterised ${name}: ${g.error ? 'ERROR ' + g.error : `${g.lit} lit cells of ${g.N}x${g.N} from a ${g.naturalWidth}x${g.naturalHeight} source`}`)
  }
  measurements.v7Masks = Object.fromEntries(
    Object.entries(refs).map(([k, v]) => [k, v.error ? { error: v.error } : { lit: v.lit, natural: [v.naturalWidth, v.naturalHeight] }])
  )

  const shipped = refs['claude (shipped)']
  if (!shipped || shipped.error) {
    record('V7', 'shipped claude.svg rasterises', false, `could not rasterise: ${shipped && shipped.error}`)
    return
  }
  record('V7', 'shipped claude.svg rasterises', true,
    `${shipped.lit} lit cells of ${N * N} from a ${shipped.naturalWidth}x${shipped.naturalHeight} source`)

  const lobehub = refs['claude (lobehub)']
  if (lobehub && !lobehub.error) {
    const same = iou(shipped.grid, lobehub.grid)
    record('V7', 'rasterised silhouette == lobehub claude', same >= 0.99,
      `IoU(shipped, lobehub) = ${round(same)} — 1.0 means pixel-identical silhouettes`, { iou: round(same) })
  }

  const anth = refs['anthropic']
  if (anth && !anth.error) {
    const i = iou(shipped.grid, anth.grid)
    record('V7', 'rasterised silhouette != anthropic', i < 0.9,
      `IoU(claude, anthropic) = ${round(i)} (threshold 0.9; recon reference 0.409 for genuinely different marks)`,
      { iou: round(i) })
    // And different from every other mark in the same way, so the number is not an
    // artefact of the grid resolution.
    for (const other of ['openai', 'groq']) {
      const o = refs[other]
      if (!o || o.error) continue
      const io = iou(shipped.grid, o.grid)
      console.log(`  cross-check IoU(claude, ${other}) = ${round(io)}`)
    }
    measurements.v7Iou = { vsAnthropic: round(i), vsLobehub: lobehub && !lobehub.error ? round(iou(shipped.grid, lobehub.grid)) : null }
  } else {
    record('V7', 'anthropic reference rasterises', null, 'no anthropic.svg in the installed package to compare against')
  }
}

// ---------------------------------------------------------------------------
// CRITERION 6b — V8 background reaches the screen
// ---------------------------------------------------------------------------

const SKY_STATE = `(() => {
  const host = document.querySelector('[data-testid="home-particle-background"]');
  if (!host) return { error: 'no particle host' };
  const sky = host.querySelector('.home-space-sky');
  if (!sky) return { error: 'no .home-space-sky element' };
  const cs = getComputedStyle(sky);
  const r = sky.getBoundingClientRect();
  return { dark: document.documentElement.classList.contains('dark'),
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    bgImage: cs.backgroundImage, bgSize: cs.backgroundSize, bgRepeat: cs.backgroundRepeat,
    rect: { w: Math.round(r.width), h: Math.round(r.height) },
    inlineDisplay: sky.style.display || '' };
})()`

const SET_THEME = (dark) => `(() => {
  document.documentElement.classList.toggle('dark', ${dark});
  return { dark: document.documentElement.classList.contains('dark') };
})()`

/**
 * Decode the sky image through the page's own loader and measure it.
 *
 * `drawImage` on an `<img>` is safe here: the caveat about reading a WebGL canvas
 * (a missing `preserveDrawingBuffer` makes it read black) applies to the particle
 * canvas, not to a decoded image. The statistics are what separate a photograph from
 * a procedural field: a real 360-degree mosaic has thousands of distinct levels, a
 * smooth histogram, and a large population of genuinely dark pixels with a bright
 * tail — a generated dot field is bimodal and has very few levels.
 */
const SKY_PIXELS = (url) => `(async () => {
  const img = new Image();
  const loaded = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = ${JSON.stringify(url)}; });
  if (!loaded || !img.naturalWidth) return { error: 'image failed to load: ' + ${JSON.stringify(url)} };
  const W = Math.min(512, img.naturalWidth), H = Math.min(288, img.naturalHeight);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const hist = new Array(256).fill(0);
  const uniq = new Set();
  let sum = 0, sum2 = 0, n = 0, dark = 0, bright = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    hist[l]++; sum += l; sum2 += l * l; n++;
    if (l < 24) dark++;
    if (l > 96) bright++;
    if (n % 4 === 0) uniq.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let peak = 0; for (const h of hist) if (h > peak) peak = h;
  return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    sampled: { W, H }, mean: +mean.toFixed(2), sd: +sd.toFixed(2),
    darkShare: +(dark / n).toFixed(4), brightShare: +(bright / n).toFixed(4),
    distinctLevels: hist.filter((h) => h > 0).length,
    dominantLevelShare: +(peak / n).toFixed(4),
    uniqueColors: uniq.size };
})()`

/**
 * The same statistics for a PROCEDURAL star field of the same size.
 *
 * This is the control that makes V8's numbers mean something. "Distinct levels >= 96"
 * and "unique colours >= 2000" are magic numbers until something is measured on the
 * other side of them; a synthetic field — black canvas, random white dots, which is
 * precisely what the superseded V1 background was — gives the other side. The check
 * then becomes "this image carries more tonal information than a generated dot field
 * of the same dimensions", which is the actual requirement ("太假了…去找网上现成的最高质量的宇宙背景图").
 */
const PROCEDURAL_CONTROL = (W, H, dots) => `(() => {
  const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#01020a'; ctx.fillRect(0, 0, ${W}, ${H});
  for (let i = 0; i < ${dots}; i++) {
    const v = 150 + Math.random() * 105;
    ctx.fillStyle = 'rgb(' + (v|0) + ',' + (v|0) + ',' + (v|0) + ')';
    ctx.fillRect((Math.random() * ${W}) | 0, (Math.random() * ${H}) | 0, 1, 1);
  }
  const d = ctx.getImageData(0, 0, ${W}, ${H}).data;
  const hist = new Array(256).fill(0);
  const uniq = new Set();
  let sum = 0, sum2 = 0, n = 0, dark = 0, bright = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    hist[l]++; sum += l; sum2 += l * l; n++;
    if (l < 24) dark++;
    if (l > 96) bright++;
    uniq.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let peak = 0; for (const h of hist) if (h > peak) peak = h;
  return { mean: +mean.toFixed(2), sd: +sd.toFixed(2), darkShare: +(dark / n).toFixed(4),
    brightShare: +(bright / n).toFixed(4), distinctLevels: hist.filter((h) => h > 0).length,
    dominantLevelShare: +(peak / n).toFixed(4), uniqueColors: uniq.size };
})()`

async function criterionV8browser(cdp) {
  console.log('\n=== CRITERION 6b — V8 background pixel statistics + theme gating ===')

  const darkState = await cdp.eval(`(() => { document.documentElement.classList.add('dark'); return true })()`)
  await sleep(900)
  await cdp.eval(RESTORE)
  await sleep(500)
  const darkSky = await cdp.eval(SKY_STATE)
  console.log('  dark: ' + JSON.stringify(darkSky))

  if (darkSky.error) {
    record('V8', 'sky element present', false, darkSky.error)
    return
  }
  record('V8', 'sky element present', true, JSON.stringify({ display: darkSky.display, rect: darkSky.rect }))

  const darkShown = darkSky.display !== 'none' && darkSky.visibility !== 'hidden' && darkSky.rect.w > 100 && darkSky.rect.h > 100
  record('V8', 'sky is displayed under the dark theme', darkShown,
    `display=${darkSky.display} visibility=${darkSky.visibility} size=${darkSky.rect.w}x${darkSky.rect.h}`,
    darkSky)

  // A `background-image` that names a URL is not proof the URL resolves: the dev
  // server's SPA fallback answers a bad asset path with HTTP 200 and HTML. Decoding
  // it in the page is what proves a real image loaded.
  const urlMatch = darkSky.bgImage.match(/url\(["']?([^"')]+)["']?\)/)
  const rawUrl = urlMatch ? urlMatch[1] : null
  record('V8', 'computed background-image is a URL', !!rawUrl,
    rawUrl || `background-image was "${darkSky.bgImage}"`)

  if (rawUrl) {
    const px = await cdp.eval(SKY_PIXELS(rawUrl))
    if (px.error) {
      record('V8', 'sky image decodes in the page', false, px.error)
    } else {
      measurements.v8Pixels = px
      console.log(`  decoded ${px.naturalWidth}x${px.naturalHeight}: mean ${px.mean}, sd ${px.sd}, ` +
        `distinct levels ${px.distinctLevels}/256, dark ${(px.darkShare * 100).toFixed(1)}%, bright ${(px.brightShare * 100).toFixed(1)}%, ` +
        `unique colours ${px.uniqueColors}, dominant level share ${(px.dominantLevelShare * 100).toFixed(1)}%`)

      record('V8', 'sky image decodes in the page', true,
        `${px.naturalWidth}x${px.naturalHeight} decoded via the page's own loader (not a stylesheet string)`, px)
      record('V8', 'decoded width >= 2048', px.naturalWidth >= 2048,
        `${px.naturalWidth}px wide (floor 2048)`)

      // The discriminating test: the photograph must carry MORE tonal information
      // than a procedurally generated star field of the same size. This is the
      // control that gives the absolute numbers a meaning — and it is the exact
      // comparison the user made ("宇宙背景是你自己生成的吗？太假了一点震撼感都没有").
      const control = await cdp.eval(PROCEDURAL_CONTROL(px.sampled.W, px.sampled.H, 4000))
      measurements.v8ProceduralControl = control
      console.log(`  procedural control (same ${px.sampled.W}x${px.sampled.H}, 4000 dots): ` +
        `mean ${control.mean}, sd ${control.sd}, distinct levels ${control.distinctLevels}, ` +
        `unique colours ${control.uniqueColors}, dominant level share ${(control.dominantLevelShare * 100).toFixed(1)}%`)

      record('V8', 'carries more tonal information than a generated dot field (distinct levels)', px.distinctLevels > control.distinctLevels * 1.5,
        `photograph has ${px.distinctLevels} distinct luminance levels vs ${control.distinctLevels} for a ` +
        `procedurally generated dot field of the same size`,
        { photo: px.distinctLevels, procedural: control.distinctLevels })
      record('V8', 'carries more colour information than a generated dot field', px.uniqueColors > control.uniqueColors * 1.5,
        `photograph has ${px.uniqueColors} distinct quantised RGB triples vs ${control.uniqueColors} for the ` +
        `control; a flat or synthetic field collapses to a handful of levels`,
        { photo: px.uniqueColors, procedural: control.uniqueColors })
      record('V8', 'no single luminance level dominates (not a flat plate)', px.dominantLevelShare < 0.5,
        `the most common luminance holds ${(px.dominantLevelShare * 100).toFixed(1)}% of pixels ` +
        `(control ${(control.dominantLevelShare * 100).toFixed(1)}%)`,
        { dominantLevelShare: px.dominantLevelShare, control: control.dominantLevelShare })
      record('V8', 'deep-sky exposure (mean well below mid-grey, real highlight tail)', px.mean < 64 && px.brightShare > 0.0005,
        `mean luminance ${px.mean}/255, ${(px.brightShare * 100).toFixed(2)}% of pixels above 96, ` +
        `${(px.darkShare * 100).toFixed(1)}% below 24 — a dark sky with real stars`,
        { mean: px.mean, brightShare: px.brightShare, darkShare: px.darkShare })
      record('V8', 'not a flat fill (standard deviation > 4)', px.sd > 4,
        `standard deviation ${px.sd} luminance levels vs ${control.sd} for the control`, { sd: px.sd, control: control.sd })
    }
  }

  // The light-theme path must NOT show the photograph: a deep-space plate under a
  // pale page destroys the light page's readability.
  await cdp.eval(SET_THEME(false))
  await sleep(1200)
  const lightSky = await cdp.eval(SKY_STATE)
  console.log('  light: ' + JSON.stringify(lightSky))
  const lightHidden = lightSky.display === 'none' || lightSky.visibility === 'hidden' || Number(lightSky.opacity) === 0
  record('V8', 'sky is hidden under the light theme', lightHidden,
    `display=${lightSky.display} visibility=${lightSky.visibility} opacity=${lightSky.opacity} ` +
    `(inline display="${lightSky.inlineDisplay}")`,
    lightSky)

  await cdp.eval(SET_THEME(true))
  await sleep(600)
}

// ---------------------------------------------------------------------------
// Falsification — prove the probe can fail
// ---------------------------------------------------------------------------

/**
 * Deliberately break the feature and assert the probe notices.
 *
 * A probe that has never reported a failure is indistinguishable from one that
 * cannot. This halves the glyph anchors at runtime — the exact defect V6 exists to
 * catch, a pattern too small — and requires the height check to flip to FAIL. The
 * anchors are restored afterwards.
 *
 * `eng.scratch.glyphTargets` is also re-derived every time the engine switches brand,
 * so the injection is applied and measured inside a single hold rather than being
 * expected to persist.
 */
async function discriminationTest(cdp) {
  console.log('\n=== DISCRIMINATION — deliberately halve the pattern and require a FAIL ===')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(2000)
  await cdp.eval(ISOLATE)
  await sleep(300)

  const got = await cdp.eval(WAIT_HOLD(60000, 0.3, 0.85))
  if (!got.ok) {
    record('DISCRIMINATION', 'reached a hold to inject into', null, `no hold: ${JSON.stringify(got)}`)
    return
  }

  const before = await cdp.eval(GEOMETRY)
  const mBefore = await measureGlyph(cdp, 'discriminate-before.png')
  const pxBefore = mBefore.thresholds[24]
  console.log(`  before: fh=${round(before.live.fh)} fw=${round(before.live.fw)} ` +
    `px fh=${pxBefore && pxBefore.lit ? round(pxBefore.fh) : 'n/a'}`)

  // Halve the glyph about its own centroid. Writing `glyphTargets` in place is what
  // the engine reads to build the hold shape, so this shrinks the pattern the way a
  // wrong world size would.
  const injected = await cdp.eval(`(() => {
    const eng = window.__SUB2API_PARTICLE_ENGINE__;
    if (!eng) return { error: 'no handle' };
    const g = eng.scratch.glyphTargets;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < g.length; i += 3) {
      if (g[i] < minX) minX = g[i]; if (g[i] > maxX) maxX = g[i];
      if (g[i + 1] < minY) minY = g[i + 1]; if (g[i + 1] > maxY) maxY = g[i + 1];
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let i = 0; i < g.length; i += 3) {
      g[i] = cx + (g[i] - cx) * 0.5;
      g[i + 1] = cy + (g[i + 1] - cy) * 0.5;
      g[i + 2] = g[i + 2] * 0.5;
    }
    return { ok: true, worldHAfter: (maxY - minY) * 0.5, cx, cy };
  })()`)
  console.log(`  injected: ${JSON.stringify(injected)}`)

  // Give the cloud a moment to converge onto the smaller targets, then read the same
  // two routes again.
  await sleep(1500)
  const after = await cdp.eval(GEOMETRY)
  const mAfter = await measureGlyph(cdp, 'discriminate-after.png')
  const pxAfter = mAfter.thresholds[24]
  console.log(`  after:  fh=${round(after.live.fh)} fw=${round(after.live.fw)} ` +
    `px fh=${pxAfter && pxAfter.lit ? round(pxAfter.fh) : 'n/a'}`)

  const heightFell = after.live.fh < before.live.fh * 0.85
  const shrank = after.live.fh < MIN_HEIGHT_SHARE
  const detection = heightFell || shrank
  record('DISCRIMINATION', 'probe detects a deliberately halved pattern', detection,
    detection
      ? `fh fell ${round(before.live.fh)} -> ${round(after.live.fh)} after halving the anchors, ` +
        `${shrank ? 'now below the 66.7% floor' : 'moved as expected'}; the probe is capable of failing V6`
      : `fh did not fall (${round(before.live.fh)} -> ${round(after.live.fh)}) after halving the anchors — ` +
        `the V6 measurement does not respond to the pattern's size and its PASS is worthless`,
    { before: round(before.live.fh), after: round(after.live.fh), shrank })

  measurements.discrimination = {
    beforeFh: round(before.live.fh), afterFh: round(after.live.fh),
    beforePixelsFh: pxBefore && pxBefore.lit ? round(pxBefore.fh) : null,
    afterPixelsFh: pxAfter && pxAfter.lit ? round(pxAfter.fh) : null,
    detected: detection,
  }

  if (!detection) {
    instrumentInvalid('the probe failed its own falsification test — it cannot detect a halved pattern')
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('framing-probe — independent acceptance probe for V3/V5/V6/V7/V8')
  console.log(`url:  ${URL_}`)
  console.log(`out:  ${OUT}`)
  console.log(`chrome: ${CHROME}`)

  if (!existsSync(CHROME) && !args['no-chrome']) {
    console.error(`chrome not found at ${CHROME} — pass --chrome=PATH`)
    process.exit(2)
  }
  if (!existsSync(FRONTEND)) {
    console.error(`frontend not found at ${FRONTEND} — pass --repo=PATH`)
    process.exit(2)
  }

  const wsUrl = await connect()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: URL_ })
  await sleep(9000)

  // The probes need the dev-only handles. Their absence means either a production
  // build is being served or the feature did not mount, and both make every
  // measurement below meaningless — so this is a hard stop, not a FAIL.
  const boot = await cdp.eval(`(() => ({
    engine: typeof window.__SUB2API_PARTICLE_ENGINE__ !== 'undefined' && !!window.__SUB2API_PARTICLE_ENGINE__,
    stats: !!window.__SUB2API_PARTICLE_STATS__,
    host: !!document.querySelector('[data-testid="home-particle-background"]'),
    canvas: !!document.querySelector('[data-testid="home-particle-background"] canvas'),
    phase: window.__SUB2API_PARTICLE_STATS__ ? window.__SUB2API_PARTICLE_STATS__.phase : null,
    particleCount: window.__SUB2API_PARTICLE_STATS__ ? window.__SUB2API_PARTICLE_STATS__.particleCount : null,
    fps: window.__SUB2API_PARTICLE_STATS__ ? Math.round(window.__SUB2API_PARTICLE_STATS__.fps) : null,
    drawCalls: window.__SUB2API_PARTICLE_STATS__ ? window.__SUB2API_PARTICLE_STATS__.drawCalls : null
  }))()`)
  console.log('\n=== BOOT ===')
  console.log('  ' + JSON.stringify(boot))
  measurements.boot = boot

  if (!boot.engine || !boot.host || !boot.canvas) {
    instrumentInvalid(
      `the page did not expose the dev handles (engine=${boot.engine}, host=${boot.host}, canvas=${boot.canvas}). ` +
      `Either a production build is being served, or the feature failed to mount. Nothing can be measured.`
    )
  }
  record('INSTRUMENT', 'dev handles present', true,
    `engine handle, stats (phase=${boot.phase}, ${boot.particleCount} particles, ${boot.fps} fps, ${boot.drawCalls} draw calls) and canvas all present`)
  record('INSTRUMENT', 'draw calls within the spec budget of 6', boot.drawCalls <= 6,
    `${boot.drawCalls} draw calls`, { drawCalls: boot.drawCalls })

  await calibrate(cdp)
  await criterionV7browser(cdp)
  await criterionV8browser(cdp)

  if (args.discriminate) {
    await discriminationTest(cdp)
  }

  // `--only=v5,v3` runs a subset, for iterating on one criterion without paying for the
  // V6 roster walk (whose brand bring-up dominates the run). It exists for development;
  // a subset run is NOT an acceptance run, and the JSON records which criteria ran so a
  // partial result cannot be mistaken for a full one.
  const only = args.only ? String(args.only).split(',').map((s) => s.trim().toLowerCase()) : null
  const wants = (name) => !only || only.includes(name)
  if (only) console.log(`\n!! PARTIAL RUN — only: ${only.join(', ')} (not an acceptance run)`)

  if (wants('v5')) await criterionV5(cdp)
  // V3 samples the dolly by waiting for one hold per beat; V6 walks the roster to
  // reach the two binding brands. Ordering V6 last keeps the long brand walk away
  // from the V3 timing window.
  if (wants('v6')) {
    const viewports = VIEWPORT_FILTER
      ? VIEWPORTS.filter((v) => VIEWPORT_FILTER.includes(v.name))
      : VIEWPORTS
    for (const vp of viewports) {
      await criterionV6(cdp, vp)
    }
  }
  if (wants('v3')) {
    await criterionV3(cdp, args['fault-pin-content']
      ? { fault: { label: 'content plane pinned — the camera retreats alone (the pre-fix defect)' } }
      : null)
  }
  measurements.partialRun = only ? { criteria: only } : null

  // The asset half runs last and its verdicts are merged in, so a single exit code
  // covers both halves.
  const assetJson = join(OUT, 'framing-probe-assets.json')
  if (existsSync(assetJson)) {
    try {
      const asset = JSON.parse(readFileSync(assetJson, 'utf8'))
      // Reflect the on-disk results, so a stale asset run cannot make this pass.
      const assetAge = Date.now() - statSyncSafe(assetJson)
      const fresh = assetAge < 3600_000
      record('V7/V8', 'asset probe results are fresh (< 1 h)', fresh,
        `framing-probe-assets.json is ${Math.round(assetAge / 1000)} s old with ` +
        `${asset.verdicts.filter((v) => v.pass === false).length} failure(s)`)
      if (asset.verdicts.some((v) => v.pass === false)) {
        for (const v of asset.verdicts.filter((x) => x.pass === false)) {
          record(v.criterion, `(assets) ${v.name}`, false, v.detail)
        }
      } else {
        record('V7/V8', '(assets) all file-level checks passed', true,
          `${asset.verdicts.filter((v) => v.pass === true).length} asset checks passed`)
      }
    } catch (e) {
      record('V7/V8', 'asset probe results parse', false, String(e).slice(0, 120))
    }
  } else {
    record('V7/V8', 'asset probe results present', false,
      `run tools/framing-probe-assets.mjs first (expected ${assetJson})`)
  }

  const failed = results.filter((r) => r.status === 'fail')
  finish(failed.length === 0 ? 0 : 1)
}

function statSyncSafe(p) {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

main().catch((e) => {
  if (e.instrumentInvalid) return finish(2)
  console.error('\nframing-probe crashed:', e.stack || e.message)
  if (chrome) chrome.kill('SIGKILL')
  process.exit(2)
})
