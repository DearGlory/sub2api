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
 * one go. `prefetch()` dispatches geometry from the idle queue to a lazy module
 * worker. Rasterisation, sampling and levelling run there on OffscreenCanvas;
 * completed buffers transfer back together. Unsupported/failed workers use the
 * idle DOM fallback. `ensure()` remains synchronous when a glyph is due.
 */
import {
  VOXSPACE_ICON_CANVAS_SIZE,
  createVoxSpaceNoiseIconTargets,
} from '../vendor/voxspace-icon-targets'
import { buildGlyphTargets } from './brandTargetsRaster'
import type {
  BrandTargetsRequest,
  BrandTargetsResponse,
  GlyphEllipse,
  GlyphSource,
} from './brandTargetsRaster'
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

/** Keeps a caller from asking for a canvas edge no device can serve. */
const MIN_CANVAS_SIZE = 96
const MAX_CANVAS_SIZE = 2048
const DEFAULT_VIEW_BOX: [number, number, number, number] = [0, 0, 24, 24]

interface PendingWork {
  id: number
  count: number
  canvasSize: number
  handle?: number
  idle?: boolean
  worker: boolean
}

/**
 * `@types/node` is in this project's type graph and also declares a global
 * `setTimeout`, whose overload wins there: it returns `NodeJS.Timeout`, a type no
 * browser ever produces. The handle really is a `number` in every DOM
 * environment, so it is narrowed once, here, instead of casting inside the
 * scheduling logic.
 */
function scheduleTimeout(handler: () => void, ms: number): number {
  return globalThis.setTimeout(handler, ms) as unknown as number
}

function cancelTimeout(handle: number): void {
  globalThis.clearTimeout(handle)
}

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
  const fillRule: GlyphSource['fillRule'] =
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

function normaliseCanvasSize(canvasSize: number | undefined): number {
  const requested = canvasSize ?? VOXSPACE_ICON_CANVAS_SIZE
  if (!Number.isFinite(requested)) return VOXSPACE_ICON_CANVAS_SIZE
  return Math.min(MAX_CANVAS_SIZE, Math.max(MIN_CANVAS_SIZE, Math.floor(requested)))
}

/** Synchronous ensure uses exactly the worker's raster and sampler. */
function buildTargets(svgText: string, count: number, canvasSize: number): BrandTargets | null {
  const source = readGlyphSource(svgText)
  if (!source || typeof document === 'undefined') return null
  return buildGlyphTargets(source, count, canvasSize, document.createElement('canvas'))
}

/**
 * Last resort when there is no glyph to read: the vendor's own noise field.
 *
 * Deliberately NOT levelled. Noise is not a logo — it is a blob standing in for one
 * the page could not read — so there is no silhouette to keep and no design height
 * to hit, and forcing it onto the glyph grid would claim a fidelity this path does
 * not have. It also has to stay centred on the origin: the engine's noise fallback
 * test asserts exactly that, and by the time it reached the camera the difference
 * would be a blob the size of a logo rather than a logo-shaped one.
 */
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
  let worker: Worker | null = null
  let workerUnavailable = false
  let nextId = 0

  function cancelPending(work: PendingWork): void {
    if (work.handle === undefined) return
    if (work.idle) globalThis.cancelIdleCallback?.(work.handle)
    else cancelTimeout(work.handle)
    work.handle = undefined
  }

  function stopWorker(): void {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    worker = null
  }

  function schedule(slug: string, work: PendingWork): void {
    const run = () => runIdle(slug, work)
    work.idle = typeof globalThis.requestIdleCallback === 'function'
    work.handle = work.idle
      ? globalThis.requestIdleCallback(run, { timeout: 500 })
      : scheduleTimeout(run, 200)
  }

  function failWorker(): void {
    workerUnavailable = true
    stopWorker()
    if (disposed) return
    // Retry each outstanding glyph in a separate idle turn. Never rasterise in
    // the error/message handler; ensure can still supersede these retries.
    for (const [slug, work] of pending) {
      if (!work.worker) continue
      cancelPending(work)
      work.worker = false
      schedule(slug, work)
    }
  }

  function getWorker(): Worker | null {
    if (worker || workerUnavailable) return worker
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      workerUnavailable = true
      return null
    }
    try {
      const active = new Worker(new URL('./brandTargets.worker.ts', import.meta.url), {
        type: 'module',
        name: 'brand-targets',
      })
      worker = active
      active.onmessage = ({ data }: MessageEvent<BrandTargetsResponse>) => {
        if (disposed || worker !== active) return
        const work = pending.get(data.slug)
        if (!work?.worker || work.id !== data.id) return
        const result = data.result
        // Only a complete pair of transferred buffers can enter the cache.
        if (!result || !(result.targets instanceof Float32Array) ||
            !(result.strokeDepth instanceof Float32Array) ||
            result.targets.length !== Math.floor(work.count * 3) ||
            result.strokeDepth.length !== Math.floor(work.count) ||
            !Number.isFinite(result.anchorCount) || result.anchorCount < 1) {
          failWorker()
          return
        }
        cancelPending(work)
        pending.delete(data.slug)
        if (!cache.has(data.slug)) cache.set(data.slug, result)
      }
      active.onerror = (event) => {
        event.preventDefault()
        if (worker === active) failWorker()
      }
      active.onmessageerror = () => {
        if (worker === active) failWorker()
      }
      return active
    } catch {
      failWorker()
      return null
    }
  }

  function runIdle(slug: string, work: PendingWork): void {
    if (disposed || pending.get(slug) !== work || cache.has(slug)) return
    work.handle = undefined
    const svgText = BRAND_SVG_TEXT.get(slug)!
    const active = getWorker()
    if (active) {
      const source = readGlyphSource(svgText)
      if (source) {
        work.worker = true
        work.idle = false
        // Bound a worker that loads but never answers (e.g. a lost renderer).
        work.handle = scheduleTimeout(failWorker, 10000)
        try {
          const request: BrandTargetsRequest = {
            id: work.id, slug, source, count: work.count, canvasSize: work.canvasSize,
          }
          active.postMessage(request)
        } catch {
          failWorker()
        }
        return
      }
    }
    pending.delete(slug)
    cache.set(slug, buildTargets(svgText, work.count, work.canvasSize) ?? noiseTargets(work.count))
  }

  return {
    get(slug: string): BrandTargets | null {
      // The whole point of the cache: a slug nobody has asked for reads as absent
      // rather than triggering a decode inside someone's frame.
      return cache.get(slug) ?? null
    },

    prefetch(slug: string, count: number, canvasSize?: number): void {
      if (disposed || !Number.isFinite(count) || count < 1) return
      if (cache.has(slug) || pending.has(slug)) return
      if (!BRAND_SVG_TEXT.has(slug)) return

      const work: PendingWork = {
        id: ++nextId, count, canvasSize: normaliseCanvasSize(canvasSize), worker: false,
      }
      pending.set(slug, work)
      schedule(slug, work)
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
      stopWorker()
    },
  }
}
