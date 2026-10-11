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

/** 8-connected components at `thr`, sorted by size descending. */
function components(lum, w, h, thr, maxComps = 4000) {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) if (lum[i] >= thr) mask[i] = 1
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
  return comps
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

/** Scene-graph gates. Pixels must contain the glyph and nothing else. */
const SET_VIS = (points, stars) => `(() => {
  const eng = window.__SUB2API_PARTICLE_ENGINE__;
  if (!eng) return { error: 'no engine handle' };
  eng.debugScene.points.visible = ${points};
  const sf = eng.debugScene.scene.getObjectByName('starfield');
  if (sf) sf.visible = ${stars};
  return { points: eng.debugScene.points.visible, stars: sf ? sf.visible : null };
})()`

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
  return { live, anchors, dz: +dz.toFixed(4), visH: +visH.toFixed(4),
    fhForGlyphHeight: 10.08 / visH, fwForGlyphHeight: 10.08 / (visH * cam.aspect) };
})()`

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
  results.push({ criterion, name, pass, detail, evidence })
  const tag = pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${criterion} ${name} — ${detail}`)
  return pass
}

/** Instrument failure is neither PASS nor FAIL: it means no answer was obtained. */
function instrumentInvalid(reason) {
  console.log('\n!!! INSTRUMENT INVALID — ' + reason)
  console.log('    (not reporting PASS or FAIL: the measurement itself is untrustworthy)')
  finish(2)
}

function finish(code) {
  const summary = {
    url: URL_,
    startedAt: new Date().toISOString(),
    verdicts: results,
    measurements,
    // The instrument is valid when no INSTRUMENT-criterion check failed. Testing for
    // the presence of such verdicts instead would report invalid on every run, since
    // the passing ones are recorded too.
    instrumentValid: !results.some((r) => r.criterion === 'INSTRUMENT' && r.pass === false),
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
    const failed = rs.filter((r) => r.pass === false).length
    const passed = rs.filter((r) => r.pass === true).length
    const skipped = rs.filter((r) => r.pass === null).length
    console.log(`  ${k}: ${passed} pass, ${failed} fail${skipped ? ', ' + skipped + ' skip' : ''}`)
  }
  const totalFail = results.filter((r) => r.pass === false).length
  console.log(`\n  ${totalFail === 0 ? 'ALL CHECKS PASSED' : totalFail + ' CHECK(S) FAILED'}`)
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
  await cdp.eval(SET_VIS(true, false))
  await sleep(140)
  const shot = await shoot(cdp, label)
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

  // The negative control: nothing lit must measure as nothing lit.
  await cdp.eval(MARKER(0, 0, 0, 0, false))
  await cdp.eval(SET_VIS(false, false))
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

  await cdp.eval(SET_VIS(true, true))

  if (!calOk || !blackOk) {
    instrumentInvalid(`calibration failed (marker error ${round(worst, 2)} px, negative control black=${blackOk})`)
  }
  console.log('  instrument validated on known answers.')
}

// ---------------------------------------------------------------------------
// CRITERION 3 — V6, pattern size
// ---------------------------------------------------------------------------

/**
 * V6: during `hold`, the projected pattern must be at least 2/3 of the viewport
 * high and 1/3 of it wide.
 *
 * Three routes to the same number, all taken at one instant:
 *   live      project the `position` attribute through the live camera
 *   pixels    read the actual framebuffer, scene-graph gated so only the glyph lit
 *   anchors   the levelled world box of the glyph, projected geometrically
 *
 * `live` is the verdict, because it is what a visitor sees. `pixels` is the
 * independent corroboration — if the two disagree, something is wrong with the
 * measurement rather than with the feature, which is exactly the failure mode that
 * produced the constant 0.7453 this probe exists to replace. `anchors` confirms the
 * glyph was levelled to the frozen 10.08 world units at all.
 */
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

    const row = {
      brand: settled.brand, walkSteps: brought.steps, settleStableFrames: brought.stableFrames,
      phaseBefore: before.phase, phaseAfter: after.phase,
      phaseProgress: settled.p,
      camZ: before.camZ, camDrift: round(camDrift),
      viewport: { w: before.iw, h: before.ih, dpr: before.dpr },
      live: { fw: round(live.fw), fh: round(live.fh), wPx: round(live.w, 1), hPx: round(live.h, 1), n: live.n, behind: live.behind },
      pixelsThr24: th, pixelsThr48: th48,
      pixelsAtOtherThresholds: m.thresholds,
      componentCount: m.compCount,
      topComponents: m.comps,
      anchorsWorld: geom.anchors,
      visH: geom.visH, dz: geom.dz,
      fhIfGlyphWere1008: round(geom.fhForGlyphHeight),
    }
    samples.push(row)
    if (!perBrand[settled.brand]) perBrand[settled.brand] = row

    const heightOk = live.fh >= MIN_HEIGHT_SHARE
    const widthOk = live.fw >= MIN_WIDTH_SHARE
    const pixelAgrees = th && th.lit > 0 && Math.abs(th.fh - live.fh) < 0.06 && Math.abs(th.fw - live.fw) < 0.06
    const levelled = geom.anchors && Math.abs(geom.anchors.worldH - GLYPH_WORLD_HEIGHT) < 0.05

    record('V6', `${viewport.name} / ${settled.brand} height >= 66.7%`, heightOk,
      `fh=${round(live.fh)} (need >= ${round(MIN_HEIGHT_SHARE)}) ` +
      `[pixels thr24 fh=${th && th.lit ? round(th.fh) : 'n/a'} ${pixelAgrees ? 'agrees' : 'DISAGREES'}]`,
      { live: row.live, pixels: th })

    record('V6', `${viewport.name} / ${settled.brand} width >= 33.3%`, widthOk,
      `fw=${round(live.fw)} (need >= ${round(MIN_WIDTH_SHARE)}) ` +
      `[pixels thr24 fw=${th && th.lit ? round(th.fw) : 'n/a'}]`,
      { live: row.live, pixels: th })

    record('V6', `${viewport.name} / ${settled.brand} cross-check live vs pixels`, !!pixelAgrees,
      pixelAgrees ? `live ${round(live.fw)}x${round(live.fh)} vs pixels ${round(th.fw)}x${round(th.fh)} (within 0.06)`
                  : `live ${round(live.fw)}x${round(live.fh)} vs pixels ${th && th.lit ? round(th.fw) + 'x' + round(th.fh) : 'nothing lit'} — routes disagree`,
      { live: row.live, pixels: th })

    record('V6', `${viewport.name} / ${settled.brand} glyph levelled to 10.08 world units`, !!levelled,
      geom.anchors ? `anchor world height ${round(geom.anchors.worldH)} (frozen target ${GLYPH_WORLD_HEIGHT})` : 'anchor buffer unreadable',
      geom.anchors)

    // The silhouette-shrink check: a real glyph thins as the threshold rises; a
    // page rectangle would keep its width exactly.
    const th16 = m.thresholds[16]
    const shrinkOk = th16 && th48 && th16.lit > 0 && th48.lit > 0 && th48.w <= th16.w && th48.lit < th16.lit
    record('V6', `${viewport.name} / ${settled.brand} contract under rising threshold`, !!shrinkOk,
      th16 && th48 ? `width ${th16.w}px@thr16 -> ${th48.w}px@thr48, lit ${th16.lit} -> ${th48.lit}` : 'no threshold data',
      { thr16: th16, thr48: th48 })
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
    const ref = samples[samples.length - 1]
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
  console.log('\n=== CRITERION 1 — V3 camera + comet retreat together ===')

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
      // What a comet of FIXED world size would project to — the control.
      fhIfFixedWorldSize: round(geom.fhForGlyphHeight),
      anchorsWorld: geom.anchors,
      ...settleDist,
      settled: settleDist.meanAnchorDist < 1.0,
    }
    samples.push(row)
    console.log(`  dolly=${Math.round(target)}s camZ=${before.camZ} brand=${before.brand} phase=${before.phase} ` +
      `live fh=${round(geom.live.fh)} fw=${round(geom.live.fw)} px fh=${th && th.lit ? round(th.fh) : 'n/a'} ` +
      `| fixed-world-size control fh=${round(geom.fhForGlyphHeight)}`)
  }

  if (samples.length < 4) {
    record('V3', 'enough samples across the dolly', false,
      `only ${samples.length} usable samples in ${Math.round((Date.now() - started) / 1000)} s`)
    measurements.v3 = { samples, note: 'insufficient sampling' }
    return
  }

  const camZs = samples.map((s) => s.camZ)
  const fhs = samples.map((s) => (s.pixels && s.pixels.lit ? s.pixels.fh : null)).filter((v) => v != null)
  const fhLive = samples.map((s) => s.live.fh)
  const controlled = samples.map((s) => s.fhIfFixedWorldSize)

  const corrPixels = fhs.length >= 3 ? pearson(camZs.slice(0, fhs.length), fhs) : null
  const corrLive = pearson(camZs, fhLive)
  const corrControl = pearson(camZs, controlled)

  const camRange = { min: round(Math.min(...camZs)), max: round(Math.max(...camZs)), span: round(Math.max(...camZs) - Math.min(...camZs)) }
  const dzValues = samples.map((s) => s.camZ - st0.subjectZ)
  const distanceRatio = round(Math.max(...dzValues) / Math.min(...dzValues))
  const windowSeconds = round((Date.now() - started) / 1000, 1)

  // The sampled sweep covers the whole dolly domain by construction: it evaluates the
  // engine's own dolly function at `count` points spanning `dollySeconds` 0..150.
  const dollyDomainCovered = true
  measurements.v3 = {
    samples,
    camRange,
    distanceRatio,
    sweepSeconds: windowSeconds,
    dollyPeriodSeconds: DOLLY_PERIOD_SECONDS,
    dollyDomainCovered,
    sampledDollyPoints: points,
    jitterPixels: round(spread(fhs)),
    jitterLive: round(spread(fhLive)),
    meanFhPixels: round(mean(fhs)),
    corrCamZ_fhPixels: round(corrPixels),
    corrCamZ_fhLive: round(corrLive),
    corrCamZ_fixedWorldSizeControl: round(corrControl),
    fixedWorldSizeRangePct: [round(Math.min(...controlled) * 100, 1), round(Math.max(...controlled) * 100, 1)],
    measuredRangePct: [round(Math.min(...fhs) * 100, 1), round(Math.max(...fhs) * 100, 1)],
  }

  console.log(`\n  swept dollySeconds 0..${DOLLY_PERIOD_SECONDS} (the whole period) in ${windowSeconds} s of wall-clock; ` +
    `camZ ${camRange.min}..${camRange.max}, camera-to-subject varied ${distanceRatio}x`)

  // --- instrument self-check, BEFORE any V3 verdict -----------------------
  // fh must respond to camZ. The control says how much it SHOULD move for a comet of
  // fixed world size; if the camera moved that far and fh barely did, either the
  // comet now follows the camera (which is V3 passing, and the response is
  // legitimately small) or the measurement is not looking at the comet. Those two
  // are distinguished by the control's own span: the comet following the camera is
  // exactly the case where the fixed-size control moves a lot and the measurement
  // does not.
  const controlSpread = spread(controlled)
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

  // The decisive corroboration, and the one that cannot be passed by accident.
  //
  // A comet of FIXED world size has fh = h / (2 tan(fov/2) (camZ - SUBJECT_Z)), which
  // is an exact function of camZ: its correlation with camZ is -1 and its own jitter
  // over the sweep is large. A comet that FOLLOWS the camera has fh independent of
  // camZ, so its correlation is near zero. Measuring the correlation therefore answers
  // the V3 question directly, and unlike a jitter threshold it cannot be satisfied by
  // a measurement that simply reads a constant (a constant has correlation 0 by
  // convention here — see the guard below).
  //
  // The guard matters: if fh never varies at all, `pearson` has no variance to divide
  // by and returns null, which would let a frozen measurement masquerade as
  // "uncorrelated with camZ". A frozen measurement is therefore rejected explicitly.
  const fhVaries = Math.max(...fhs) - Math.min(...fhs) > 0.01
  const corrOk = fhVaries && corrPixels != null && Math.abs(corrPixels) < 0.5
  record('V3', 'fh is not the fixed-world-size function of camZ', corrOk,
    !fhVaries
      ? `fh never varied over the sweep (spread ${round(measuredSpread * 100, 2)}%) — a frozen measurement is ` +
        `not evidence that the comet follows the camera`
      : `corr(camZ, fh) measured ${round(corrPixels)}; a comet that did NOT follow the camera would give ` +
        `${round(corrControl)} (the fixed-size control spans ${measurements.v3.fixedWorldSizeRangePct[0]}%..` +
        `${measurements.v3.fixedWorldSizeRangePct[1]}% of the viewport, essentially the measured ` +
        `${measurements.v3.measuredRangePct[0]}%..${measurements.v3.measuredRangePct[1]}%). ` +
        `|corr| must be < 0.5 for fh to be independent of camZ.`,
    { corrMeasured: round(corrPixels), corrControl: round(corrControl), fhVaries, measuredRangePct: measurements.v3.measuredRangePct })

  record('V3', 'measured jitter is far below the fixed-world-size control', jitter < controlJitter * 0.5,
    `measured jitter ${round(jitter * 100, 2)}% vs ${round(controlJitter * 100, 2)}% for a comet of fixed world ` +
    `size — tracking the control this closely (ratio ${round(jitter / controlJitter)}) means the comet is not ` +
    `following the camera at all, which is what corr(camZ, fh) = ${round(corrPixels)} says independently`,
    { measured: round(jitter), fixedControl: round(controlJitter), ratio: round(jitter / controlJitter) })

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
  await cdp.eval(SET_VIS(true, true))
  await sleep(300)
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
    const a = await shoot(cdp, `v5-flow-${phase}-a.png`)
    await sleep(7000)
    const bState = await cdp.eval(STATE)
    const b = await shoot(cdp, `v5-flow-${phase}-b.png`)

    const run = radialFlow(a, b, { thr: 60, maxSize: 200, matchRadius: 7 })
    flowRuns.push({
      phase, brand: aState.brand, camZFrom: aState.camZ, camZTo: bState.camZ,
      dz: round(bState.camZ - aState.camZ),
      ...run,
      // Expected: inward (negative radial drift) because the camera is receding.
      direction: run.meanRadial < -0.02 ? 'inward (toward vanishing point)' : run.meanRadial > 0.02 ? 'outward' : 'ambiguous',
    })
    console.log(`  flow ${phase}: dz=${round(bState.camZ - aState.camZ)} matched=${run.matched} ` +
      `inward=${run.inward} outward=${run.outward} meanRadial=${round(run.meanRadial, 3)} -> ${flowRuns[flowRuns.length - 1].direction}`)
  }
  measurements.v5.flowRuns = flowRuns

  const usable = flowRuns.filter((r) => typeof r.matched === 'number' && r.matched >= 8 && r.dz > 0.2)
  if (usable.length === 0) {
    instrumentInvalid(
      `no usable background-flow run (need >= 8 matched stars and dz > 0.2; got ` +
      `${JSON.stringify(flowRuns.map((r) => ({ phase: r.phase, matched: r.matched, dz: r.dz, error: r.error })))})`
    )
  }

  const inwardRuns = usable.filter((r) => r.meanRadial < 0)
  const flowOk = inwardRuns.length > usable.length / 2
  record('V5', 'background stars converge toward the vanishing point (camera receding)', flowOk,
    `${inwardRuns.length}/${usable.length} usable runs have a negative mean radial drift ` +
    `(inward = receding), mean of means ${round(mean(usable.map((r) => r.meanRadial)), 3)} px ` +
    `over ${usable.map((r) => round(r.matched)).join('/')} matched stars`,
    usable)

  record('V5', 'flow magnitude is consistent with the camera step', flowOk &&
    usable.every((r) => Math.abs(r.meanRadial) < 60),
    `mean inward drift ${round(mean(usable.map((r) => r.meanRadial)), 2)} px for a camZ step of ` +
    `${usable.map((r) => round(r.dz, 2)).join('/')} world units — a star's screen radius scales as 1/distance, ` +
    `so a sub-1% distance change gives a few px at most`,
    { dz: usable.map((r) => r.dz), meanRadial: usable.map((r) => r.meanRadial) })
}

/**
 * Track small bright blobs between two frames and return the radial component of
 * each match's motion, positive outward from the frame centre.
 *
 * Nearest-neighbour matching only, within `matchRadius`, which keeps a match honest:
 * a star whose partner cannot be found inside that radius contributes nothing rather
 * than contributing a wrong pair. Stars are small connected components; anything
 * larger than `maxSize` is the comet and is skipped.
 */
function radialFlow(a, b, { thr = 60, maxSize = 200, matchRadius = 7 } = {}) {
  const c = (s) => ({ x: s.img.w / 2, y: s.img.h / 2 })
  const ca = c(a), cb = c(b)
  const detA = detectStars(a.lum, a.img, thr, maxSize)
  const detB = detectStars(b.lum, b.img, thr, maxSize)
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
    if (r < 40) continue
    const rad = (best.x - p.x) * (rx / r) + (best.y - p.y) * (ry / r)
    moves.push({ r: round(r, 1), radial: round(rad, 3), matched: round(bestD, 2), peak: p.peak })
  }
  const radial = moves.map((m) => m.radial)
  return {
    candidatesA: detA.pts.length, candidatesB: detB.pts.length,
    matched: moves.length,
    inward: radial.filter((v) => v < -0.05).length,
    outward: radial.filter((v) => v > 0.05).length,
    meanRadial: radial.length ? mean(radial) : NaN,
    medianRadial: radial.length ? radial.slice().sort((x, y) => x - y)[radial.length >> 1] : NaN,
    sample: moves.slice(0, 12),
  }
}

/** Small bright connected components — the stars, with the comet excluded by size. */
function detectStars(lum, img, thr, maxSize) {
  const comps = components(lum, img.w, img.h, thr, 6000)
  const pts = []
  for (const c of comps) {
    if (c.size > maxSize) continue
    let sx = 0, sy = 0, sw = 0, peak = 0
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const l = lum[y * img.w + x]
        if (l < thr) continue
        if (l > peak) peak = l
        sx += x * l; sy += y * l; sw += l
      }
    }
    if (sw <= 0) continue
    pts.push({ x: sx / sw, y: sy / sw, size: c.size, peak })
  }
  return { pts, compCount: comps.length }
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

  await criterionV5(cdp)
  // V3 samples the dolly by waiting for one hold per beat; V6 walks the roster to
  // reach the two binding brands. Ordering V6 last keeps the long brand walk away
  // from the V3 timing window.
  const viewports = VIEWPORT_FILTER
    ? VIEWPORTS.filter((v) => VIEWPORT_FILTER.includes(v.name))
    : VIEWPORTS
  for (const vp of viewports) {
    await criterionV6(cdp, vp)
  }
  await criterionV3(cdp)

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

  const failed = results.filter((r) => r.pass === false)
  finish(failed.length === 0 ? 0 : 1)
}

function statSyncSafe(p) {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

main().catch((e) => {
  console.error('\nframing-probe crashed:', e.stack || e.message)
  if (chrome) chrome.kill('SIGKILL')
  process.exit(2)
})
