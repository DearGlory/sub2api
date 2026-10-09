/**
 * LANE L3 — brand glyph sampler.
 *
 * Turns the 28 official brand SVGs in `assets/brands/` into the particle anchors
 * the comet gathers onto (HOME-PARTICLE-DESIGN.md R8/R9, §6 items 7 and 8).
 *
 * How the glyph becomes an alpha mask
 * -----------------------------------
 * The SVGs arrive as *text* (Vite `?raw` glob) and that text goes through
 * `DOMParser` -> `Path2D` -> a 2D canvas, whose alpha channel is the mask the
 * vendored sampler consumes.
 *
 * The reference implementation feeds an `<img>` to `drawImage`, which cannot be
 * used here for a contract reason rather than a stylistic one: `ensure()` is
 * specified as *"Synchronously produce the targets"*, and an `<img>` only ever
 * delivers its pixels on `onload`. Every `<img>`-based version of this file would
 * either return `null` from the first `ensure()` or need a signature the frozen
 * contract does not have. `Path2D` keeps the browser doing the curve maths (no
 * SVG geometry is reimplemented here) while staying inside one synchronous call.
 *
 * Reading the files through the bundler rather than `public/` removes three
 * failure classes the `<img>` route has to defend against:
 *   - no data URL is built, so `#`, `%` and non-ASCII cannot corrupt it;
 *   - nothing is injected into the document, so there is no XSS surface and no
 *     CSP interaction;
 *   - `fill="currentColor"` never has to resolve, so no isolated document's
 *     initial colour is depended on.
 * The cost is ~28 KB of path text inlined in the bundle — the 28 SVGs total
 * 28 KB, less than one of the mask buffers they produce.
 *
 * Laziness (§6 items 7 and 8)
 * ---------------------------
 * Nothing is rasterised at import time and the 28 logos are never rasterised in
 * one go. `prefetch()` puts a decode on the idle queue; `ensure()` is the
 * synchronous path the engine takes when a glyph is actually due.
 */
import {
  VOXSPACE_ICON_CANVAS_SIZE,
  VOXSPACE_ICON_MASK_ALPHA,
  buildVoxSpaceIconTargets,
  createVoxSpaceNoiseIconTargets,
} from '../vendor/voxspace-icon-targets'
import type { BrandTargetSource, BrandTargets } from './types'

/**
 * Eager `?raw` glob rather than a lazy one: `ensure()` answers synchronously, so
 * the path text has to be in memory before it is called, and a lazy glob would
 * hand back a `() => Promise<string>`. Eager also means the icons are bundled
 * instead of fetched, so a glyph can never fail to gather on a network request.
 */
const BRAND_SVG_MODULES = import.meta.glob<string>('../assets/brands/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** `../assets/brands/openai.svg` -> `openai`. */
const SLUG_PATTERN = /\/([^/]+)\.svg$/

const BRAND_SVG_TEXT = new Map<string, string>()
for (const [path, text] of Object.entries(BRAND_SVG_MODULES)) {
  const match = SLUG_PATTERN.exec(path)
  if (match) BRAND_SVG_TEXT.set(match[1], text)
}

/** The vendor's anchor walk, restated so `anchorCount` can be reported. */
const ICON_MASK_STEP = 3

/** The glyph is drawn into the middle 80% of the canvas, as the sampler expects. */
const ICON_DRAW_INSET = 0.1
const ICON_DRAW_SPAN = 0.8

/** Keeps a caller from asking for a canvas edge no device can serve. */
const MIN_CANVAS_SIZE = 96
const MAX_CANVAS_SIZE = 2048

const DEFAULT_VIEW_BOX: [number, number, number, number] = [0, 0, 24, 24]

type FillRule = 'evenodd' | 'nonzero'

interface GlyphEllipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** One SVG document, reduced to the parts a rasteriser needs. */
interface GlyphSource {
  /** `minX minY width height`, already validated. */
  viewBox: [number, number, number, number]
  /** Raw `d` attributes, in document order. */
  paths: string[]
  ellipses: GlyphEllipse[]
  fillRule: FillRule
}

interface PendingWork {
  /** `requestIdleCallback` / `setTimeout` handle, as the DOM numbers them. */
  handle: number
  idle: boolean
}

/**
 * `@types/node` is in this project's type graph and also declares a global
 * `setTimeout`, whose overload wins there: it returns `NodeJS.Timeout`, a type no
 * browser ever produces. The handle really is a `number` in every DOM
 * environment, so it is narrowed once, here, instead of casting inside the
 * scheduling logic.
 */
const scheduleTimeout = globalThis.setTimeout as unknown as (
  handler: () => void,
  ms: number
) => number

const cancelTimeout = globalThis.clearTimeout as unknown as (handle: number) => void

// ---------------------------------------------------------------------------
// SVG text -> geometry
// ---------------------------------------------------------------------------

/**
 * Pulls the drawable geometry out of one SVG document.
 *
 * `DOMParser` rather than a regex over `d="..."`: quoting, attribute order and
 * whitespace belong to the vendor, and the parsed document also carries the real
 * `viewBox`. The checked-in assets are uniform today (only `<path>` and a single
 * `<ellipse>`, `fill-rule="evenodd"`, no `transform`/`mask`/`<use>`, no external
 * references), but parsing them properly costs nothing and means a re-export of
 * the icon set cannot silently produce a wrong silhouette.
 *
 * Walking the elements is also why `Path2D(svgText)` is not enough on its own: it
 * parses path data only, so the single `<ellipse cx cy rx ry>` in `yi.svg` would
 * be dropped.
 */
function readGlyphSource(svgText: string): GlyphSource | null {
  if (typeof DOMParser === 'undefined') return null

  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return null

  const paths: string[] = []
  for (const node of Array.from(doc.getElementsByTagName('path'))) {
    const d = node.getAttribute('d')
    if (d) paths.push(d)
  }

  const ellipses: GlyphEllipse[] = []
  for (const node of Array.from(doc.getElementsByTagName('ellipse'))) {
    const ellipse = readEllipse(node)
    if (ellipse) ellipses.push(ellipse)
  }

  if (paths.length === 0 && ellipses.length === 0) return null

  const root = doc.documentElement
  // The assets declare `evenodd` on the root element. The SVG default is
  // `nonzero`, so falling back to the specification default is the right guess for
  // an icon that does not say — the counters in these logo marks genuinely depend
  // on getting the rule right.
  const fillRule: FillRule =
    root?.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero'

  return { viewBox: readViewBox(root), paths, ellipses, fillRule }
}

/** `viewBox="minX minY width height"`, defaulted to the vendor's `0 0 24 24`. */
function readViewBox(root: Element | null | undefined): [number, number, number, number] {
  const raw = root?.getAttribute('viewBox')
  if (!raw) return DEFAULT_VIEW_BOX

  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4) return DEFAULT_VIEW_BOX

  const [minX, minY, width, height] = parts
  if (![minX, minY, width, height].every(Number.isFinite)) return DEFAULT_VIEW_BOX
  if (width <= 0 || height <= 0) return DEFAULT_VIEW_BOX
  return [minX, minY, width, height]
}

function readEllipse(node: Element): GlyphEllipse | null {
  const cx = Number(node.getAttribute('cx'))
  const cy = Number(node.getAttribute('cy'))
  const rx = Number(node.getAttribute('rx'))
  const ry = Number(node.getAttribute('ry'))
  if (![cx, cy, rx, ry].every(Number.isFinite)) return null
  if (rx <= 0 || ry <= 0) return null
  return { cx, cy, rx, ry }
}

// ---------------------------------------------------------------------------
// Geometry -> alpha mask
// ---------------------------------------------------------------------------

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Dropping the backing store here instead of leaving it to the collector is what
  // keeps peak bitmap memory at one canvas rather than one per brand.
  canvas.width = 0
  canvas.height = 0
}

/**
 * Rasterises the glyph and returns its alpha channel as a `size * size` mask, or
 * `null` in an environment that cannot rasterise (no 2D context, no `Path2D`).
 *
 * The canvas edge is the same `size` the sampler is handed, and this function only
 * ever returns a mask of exactly that length, so the sampler's pixel-to-world
 * conversion (it divides by `size`) can never be fed a mismatched pair. That is
 * the one arithmetic error in this file that would pass review and still scale
 * every particle's glyph by the wrong constant.
 */
function rasteriseGlyphMask(source: GlyphSource, size: number): Uint8Array | null {
  if (typeof Path2D === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    releaseCanvas(canvas)
    return null
  }

  let outline: Path2D
  try {
    outline = new Path2D()
    for (const d of source.paths) outline.addPath(new Path2D(d))
    for (const { cx, cy, rx, ry } of source.ellipses) {
      // Added to the same path so the whole glyph fills in one call under one
      // rule, which is how the source SVG draws it.
      outline.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    }
  } catch {
    // `Path2D` throws on malformed path data; a bad asset degrades, never throws.
    releaseCanvas(canvas)
    return null
  }

  const [minX, minY, viewBoxWidth, viewBoxHeight] = source.viewBox
  const inset = size * ICON_DRAW_INSET
  const span = size * ICON_DRAW_SPAN
  const scaleX = span / viewBoxWidth
  const scaleY = span / viewBoxHeight

  // The same box the reference `drawImage(image, size*0.1, size*0.1, size*0.8, …)`
  // used, expressed as a transform so the `Path2D` geometry lands in the same
  // place. The scales are kept separate on purpose: the drawImage form stretches
  // to fill its box, and matching it keeps these anchors on the footprint the rest
  // of the feature was tuned against. Every asset is a square `0 0 24 24` today,
  // so the two are equal.
  ctx.setTransform(scaleX, 0, 0, scaleY, inset - minX * scaleX, inset - minY * scaleY)
  // Only the alpha channel is read; white is chosen so the buffer is obvious in a
  // debugger, not because the colour matters.
  ctx.fillStyle = '#ffffff'
  ctx.fill(outline, source.fillRule)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  let mask: Uint8Array
  try {
    // Nothing drawn here comes from another origin, so the canvas cannot be
    // tainted and `getImageData` cannot throw `SecurityError`; this guard only
    // covers a context that died mid-draw.
    const pixels = ctx.getImageData(0, 0, size, size).data
    mask = new Uint8Array(size * size)
    for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3]
  } catch {
    releaseCanvas(canvas)
    return null
  }

  releaseCanvas(canvas)
  return mask
}

/**
 * Mirrors the sampler's 3-pixel walk to count the distinct anchors the glyph
 * offers. The vendor keeps its step private, so the constant is restated; this is
 * a diagnostic number, and if that step ever changed only `anchorCount` would
 * drift — no particle position depends on it.
 */
function countMaskAnchors(mask: Uint8Array, size: number): number {
  let anchors = 0
  for (let y = 0; y < size; y += ICON_MASK_STEP) {
    const row = y * size
    for (let x = 0; x < size; x += ICON_MASK_STEP) {
      if (mask[row + x] > VOXSPACE_ICON_MASK_ALPHA) anchors++
    }
  }
  return anchors
}

function normaliseCanvasSize(canvasSize: number | undefined): number {
  const requested = canvasSize ?? VOXSPACE_ICON_CANVAS_SIZE
  if (!Number.isFinite(requested)) return VOXSPACE_ICON_CANVAS_SIZE
  return Math.min(MAX_CANVAS_SIZE, Math.max(MIN_CANVAS_SIZE, Math.floor(requested)))
}

/** The whole glyph pipeline, or `null` when this environment or asset cannot serve it. */
function buildTargets(
  svgText: string,
  count: number,
  canvasSize: number
): BrandTargets | null {
  const source = readGlyphSource(svgText)
  if (!source) return null

  const mask = rasteriseGlyphMask(source, canvasSize)
  if (!mask) return null

  // Belt and braces: the sampler is handed the very edge the mask was cut from,
  // never a caller-supplied number, so a resize bug cannot reach it.
  if (mask.length !== canvasSize * canvasSize) return null

  const sampled = buildVoxSpaceIconTargets(mask, canvasSize, count)
  if (!sampled) return null

  return {
    targets: sampled.targets,
    strokeDepth: sampled.strokeDepth,
    anchorCount: countMaskAnchors(mask, canvasSize),
  }
}

/** Last resort when there is no glyph to read: the vendor's own noise field. */
function noiseTargets(count: number): BrandTargets {
  const noise = createVoxSpaceNoiseIconTargets(count)
  return {
    targets: noise.targets,
    strokeDepth: noise.strokeDepth,
    // With no outline to read, every particle is its own anchor.
    anchorCount: count,
  }
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export function createBrandTargetSource(): BrandTargetSource {
  /**
   * Keyed by slug alone, deliberately.
   *
   * `get(slug)` takes no canvas size, so a size-keyed cache could not be read back
   * through the frozen interface — and the quality ladder does not need one:
   * `probeQualityProfile()` runs once per mount in `HomeParticleBackground`, so
   * `canvasSize` is constant for a page's life and the first size to arrive is the
   * only one that can ever be asked for. Keying by size would just hold a second
   * copy of a glyph the page cannot reach.
   */
  const cache = new Map<string, BrandTargets>()
  const pending = new Map<string, PendingWork>()
  let disposed = false

  function cancelPending(work: PendingWork): void {
    if (work.idle) {
      if (typeof globalThis.cancelIdleCallback === 'function') {
        globalThis.cancelIdleCallback(work.handle)
      }
    } else {
      cancelTimeout(work.handle)
    }
  }

  function runIdle(slug: string, count: number, canvasSize: number): void {
    // Guard the callback as well as the caller: an idle task can still fire after
    // `dispose()`, and building the glyph then would resurrect a whole brand.
    if (disposed) return
    pending.delete(slug)
    if (cache.has(slug)) return

    const svgText = BRAND_SVG_TEXT.get(slug)
    cache.set(
      slug,
      svgText
        ? (buildTargets(svgText, count, canvasSize) ?? noiseTargets(count))
        : noiseTargets(count)
    )
  }

  return {
    get(slug: string): BrandTargets | null {
      // The whole point of the cache: a slug nobody has asked for reads as absent
      // rather than triggering a decode inside someone's frame.
      return cache.get(slug) ?? null
    },

    prefetch(slug: string, count: number, canvasSize?: number): void {
      if (disposed) return
      if (cache.has(slug) || pending.has(slug)) return
      // A slug with no asset would only ever produce noise, which is a valid
      // answer but never worth computing ahead of time.
      if (!BRAND_SVG_TEXT.has(slug)) return

      const size = normaliseCanvasSize(canvasSize)
      // §6 item 8: off the critical path. The timeout fallback is long enough that
      // it lands after the frame that asked for it.
      if (typeof globalThis.requestIdleCallback === 'function') {
        pending.set(slug, {
          handle: globalThis.requestIdleCallback(() => runIdle(slug, count, size)),
          idle: true,
        })
      } else {
        pending.set(slug, {
          handle: scheduleTimeout(() => runIdle(slug, count, size), 200),
          idle: false,
        })
      }
    },

    ensure(slug: string, count: number, canvasSize?: number): BrandTargets | null {
      if (disposed) return null
      if (!Number.isFinite(count) || count < 1) return null

      const cached = cache.get(slug)
      if (cached) return cached

      // The synchronous path supersedes any queued idle work for this slug.
      const queued = pending.get(slug)
      if (queued) {
        cancelPending(queued)
        pending.delete(slug)
      }

      const svgText = BRAND_SVG_TEXT.get(slug)
      // No asset for this slug means there is no glyph to read. Reporting that is
      // better than handing back noise for a brand the caller believes exists.
      if (!svgText) return null

      // A missing context, an unparsable asset or an empty mask all degrade to
      // noise: the comet still has somewhere to go, and no caller has to handle a
      // throw from inside its frame loop.
      const targets =
        buildTargets(svgText, count, normaliseCanvasSize(canvasSize)) ?? noiseTargets(count)
      cache.set(slug, targets)
      return targets
    },

    dispose(): void {
      disposed = true
      cache.clear()
      for (const work of pending.values()) cancelPending(work)
      pending.clear()
    },
  }
}
