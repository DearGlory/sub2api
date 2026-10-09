/**
 * Lane L3 — brand glyph sampler (HOME-PARTICLE-DESIGN.md §7).
 *
 * jsdom ships neither `Path2D` nor a 2D canvas context, so the browser's own
 * rasteriser cannot run in CI. The suite is layered so no part of the sampler
 * goes unverified:
 *
 *   - `all 28 official logos` drives the *whole* pipeline against a stub canvas
 *     and runs everywhere. It proves every asset parses, reaches the sampler and
 *     yields a real mask rather than the noise fallback, with the right buffer
 *     shapes.
 *   - `the real rasteriser`, skipped in plain jsdom, adds the shape-fidelity
 *     evidence a stub cannot give: anchors that really came from the logo's own
 *     silhouette, and a footprint that survives a change of `iconCanvasSize`.
 *   - the rest asserts the contract: laziness, `canvasSize` plumbing, the noise
 *     fallback, and `dispose()`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  VOXSPACE_ICON_CANVAS_SIZE,
  VOXSPACE_ICON_WORLD_SIZE,
} from '../../vendor/voxspace-icon-targets'
import { ICON_CENTER_X } from '../../vendor/voxspace-math'
import { createBrandTargetSource } from '../brandTargets'
import { BRANDS } from '../constants'
import type { BrandTargetSource, BrandTargets } from '../types'

const SLUGS = BRANDS.map((brand) => brand.slug)

/** The module's own capability gate, so both blocks agree on what is testable. */
const CAN_RASTERISE = typeof Path2D !== 'undefined'

// --- small helpers over the raw buffers ------------------------------------

function meanX(targets: Float32Array, count: number): number {
  let sum = 0
  for (let i = 0; i < count; i++) sum += targets[i * 3]
  return sum / count
}

function extentX(targets: Float32Array, count: number): number {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    const x = targets[i * 3]
    if (x < min) min = x
    if (x > max) max = x
  }
  return max - min
}

function allFinite(array: Float32Array): boolean {
  for (let i = 0; i < array.length; i++) {
    if (!Number.isFinite(array[i])) return false
  }
  return true
}

/** The frozen shape every successful result must have, real glyph or noise. */
function expectContractShaped(targets: BrandTargets | null, count: number): BrandTargets {
  expect(targets).not.toBeNull()
  const value = targets as BrandTargets
  expect(value.targets).toBeInstanceOf(Float32Array)
  expect(value.strokeDepth).toBeInstanceOf(Float32Array)
  expect(value.targets.length).toBe(count * 3)
  expect(value.strokeDepth.length).toBe(count)
  expect(value.anchorCount).toBeGreaterThan(0)
  expect(allFinite(value.targets)).toBe(true)
  expect(allFinite(value.strokeDepth)).toBe(true)
  return value
}

// --- the stub canvas --------------------------------------------------------

interface StubRecord {
  /** Edge of the canvas the module actually created. */
  canvasWidth: number
  /** The `w, h` it asked `getImageData` for. */
  readWidth: number
  readHeight: number
  /** The glyph box scale it applied before filling, captured before the reset. */
  glyphScale: number | null
  /** How many surfaces it built, i.e. how much rasterising really happened. */
  surfaceCount: number
}

/**
 * A deliberately dumb stand-in for the browser's canvas: it fills the *entire*
 * surface instead of the glyph. It cannot tell one logo from another, and it is
 * not asked to — a full mask still travels the whole pipeline, so the assertions
 * can check the canvas edge, the transform box, the mask length and the sampler
 * argument against each other. Silhouette fidelity is what the real-canvas block
 * is for.
 */
function installStubRasteriser(record: StubRecord): () => void {
  // One cast, held in a variable: writing `;(globalThis as {…})` inline needs a
  // leading semicolon to survive ASI, which is both noisy and lint-flagged.
  const scope = globalThis as { Path2D?: unknown }
  const originalPath2D = scope.Path2D
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  class StubPath2D {
    addPath(_path: StubPath2D): void {}
    ellipse(): void {}
  }

  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string
  ) {
    if (type !== '2d') return null
    record.surfaceCount += 1
    record.canvasWidth = this.width
    let firstTransform = true
    return {
      setTransform(a: number) {
        // The module applies the glyph transform first and resets to identity
        // after filling, so only the first call carries the box scale.
        if (firstTransform) {
          record.glyphScale = a
          firstTransform = false
        }
      },
      fillStyle: '',
      fill() {},
      getImageData(_x: number, _y: number, width: number, height: number) {
        record.readWidth = width
        record.readHeight = height
        const data = new Uint8ClampedArray(width * height * 4)
        // Alpha 255 everywhere: "the whole canvas is glyph".
        for (let i = 3; i < data.length; i += 4) data[i] = 255
        return { data }
      }
    }
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  scope.Path2D = StubPath2D

  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    if (originalPath2D === undefined) {
      delete scope.Path2D
    } else {
      scope.Path2D = originalPath2D
    }
  }
}

function createStubRecord(): StubRecord {
  return {
    canvasWidth: 0,
    readWidth: 0,
    readHeight: 0,
    glyphScale: null,
    surfaceCount: 0
  }
}

// ---------------------------------------------------------------------------
// The whole pipeline, end to end, for every shipped asset
// ---------------------------------------------------------------------------

describe('all 28 official logos reach the sampler under a stub rasteriser', () => {
  const count = 300
  let restore: (() => void) | null = null
  let source: BrandTargetSource | null = null
  let record: StubRecord

  afterEach(() => {
    source?.dispose()
    source = null
    restore?.()
    restore = null
  })

  it('produces contract-shaped anchors for every slug', () => {
    record = createStubRecord()
    restore = installStubRasteriser(record)
    source = createBrandTargetSource()

    expect(SLUGS.length).toBe(28)

    const results = SLUGS.map((slug) => [slug, source!.ensure(slug, count)] as const)
    const failures = results.filter(([, targets]) => targets === null).map(([slug]) => slug)
    expect(failures).toEqual([])

    for (const [slug, targets] of results) {
      const value = expectContractShaped(targets, count)
      // The discriminator between "the asset was read" and "we quietly handed back
      // noise": a glyph has interior pixels, so some anchor sits away from the
      // outline and reads a non-zero stroke depth. The noise fallback is all
      // zeros. Without this check a slug whose SVG failed to parse would still
      // pass every other assertion here.
      expect(
        value.strokeDepth.some((depth) => depth > 0),
        `${slug} produced a mask with no interior, so it fell back to noise`
      ).toBe(true)
    }

    // 28 assets really were rasterised, once each — not zero times.
    expect(record.surfaceCount).toBe(SLUGS.length)
  })

  it('passes the requested canvasSize to the canvas, the read and the sampler', () => {
    record = createStubRecord()
    restore = installStubRasteriser(record)
    source = createBrandTargetSource()

    const canvasSize = 512
    const value = expectContractShaped(source.ensure(SLUGS[0], 64, canvasSize), 64)

    // The three numbers that must be one number. If the canvas were cut at one
    // size and the sampler told another, `getImageData` would have been asked for
    // a different box, or the sampler's pixel-to-world division would silently
    // rescale every anchor.
    expect(record.canvasWidth).toBe(canvasSize)
    expect(record.readWidth).toBe(canvasSize)
    expect(record.readHeight).toBe(canvasSize)
    // 0.8 * 512 / 24: the glyph box, expressed as a transform rather than a
    // `drawImage` rect.
    expect(record.glyphScale).toBeCloseTo((canvasSize * 0.8) / 24, 6)
    expect(value.targets.length).toBe(64 * 3)
  })

  it('falls back to the frozen 760 when no canvasSize is given', () => {
    record = createStubRecord()
    restore = installStubRasteriser(record)
    source = createBrandTargetSource()

    source.ensure(SLUGS[0], 32)
    expect(record.canvasWidth).toBe(VOXSPACE_ICON_CANVAS_SIZE)
    expect(record.readWidth).toBe(VOXSPACE_ICON_CANVAS_SIZE)
  })

  it('maps the glyph square onto VOXSPACE_ICON_WORLD_SIZE, centred on ICON_CENTER_X', () => {
    record = createStubRecord()
    restore = installStubRasteriser(record)
    source = createBrandTargetSource()

    const localCount = 256
    const value = expectContractShaped(source.ensure(SLUGS[0], localCount), localCount)

    // A full-canvas mask is the whole glyph box, so the anchors must span the world
    // square and sit on the icon centre. Noise would be centred on zero.
    const extent = extentX(value.targets, localCount)
    expect(extent).toBeGreaterThan(VOXSPACE_ICON_WORLD_SIZE * 0.95)
    expect(extent).toBeLessThanOrEqual(VOXSPACE_ICON_WORLD_SIZE * 1.05)
    expect(meanX(value.targets, localCount)).toBeGreaterThan(ICON_CENTER_X - 0.6)
    expect(meanX(value.targets, localCount)).toBeLessThan(ICON_CENTER_X + 0.6)
  })
})

// ---------------------------------------------------------------------------
// The browser's own rasteriser
// ---------------------------------------------------------------------------

describe('the real rasteriser', () => {
  describe.skipIf(!CAN_RASTERISE)('available', () => {
    const count = 300
    let source: BrandTargetSource | null = null

    afterEach(() => {
      source?.dispose()
      source = null
    })

    it('draws each logo as its own silhouette, not as a blob', () => {
      source = createBrandTargetSource()

      for (const slug of SLUGS) {
        const value = expectContractShaped(source.ensure(slug, count), count)
        // Evidence the shape came from the logo file rather than from the fallback:
        // noise is a sphere of radius 4..11 around the origin, so a glyph shows both
        // an offset from the icon centre and a bounded x-extent.
        const x = meanX(value.targets, count)
        expect(Math.abs(x), `${slug} is centred on the origin like noise`).toBeGreaterThan(0.5)
        expect(x).toBeGreaterThan(ICON_CENTER_X - 3)
        expect(x).toBeLessThan(ICON_CENTER_X + 3)
        expect(extentX(value.targets, count)).toBeGreaterThan(1)
        expect(extentX(value.targets, count)).toBeLessThan(VOXSPACE_ICON_WORLD_SIZE + 0.5)
        // Distinct anchors, i.e. the mask did not collapse to a single pixel.
        expect(value.anchorCount).toBeGreaterThan(1)
      }
    })

    it('keeps the glyph footprint when iconCanvasSize shrinks', () => {
      // Two sources, because the cache is keyed by slug: this measures the *same*
      // glyph at two mask resolutions, which is the only way to isolate the one
      // variable under test.
      const fine = createBrandTargetSource()
      const coarse = createBrandTargetSource()
      try {
        const full = expectContractShaped(
          fine.ensure('openai', count, VOXSPACE_ICON_CANVAS_SIZE),
          count
        )
        const small = expectContractShaped(coarse.ensure('openai', count, 320), count)

        // A coarser mask may space the anchors differently; it must not move them.
        // This is what would break if `size` reached the sampler as anything other
        // than the edge the mask was actually cut from.
        const fullExtent = extentX(full.targets, count)
        const smallExtent = extentX(small.targets, count)
        expect(smallExtent).toBeGreaterThan(fullExtent * 0.8)
        expect(smallExtent).toBeLessThan(fullExtent * 1.2)
        // Stroke depth is a world-unit distance, so its range must stay comparable
        // even though the mask got coarser.
        const maxFull = Math.max(...Array.from(full.strokeDepth))
        const maxSmall = Math.max(...Array.from(small.strokeDepth))
        expect(maxSmall).toBeLessThan(maxFull * 3)
      } finally {
        fine.dispose()
        coarse.dispose()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('createBrandTargetSource', () => {
  let source: BrandTargetSource

  afterEach(() => {
    source.dispose()
  })

  it('is lazy: nothing is decoded until something asks', () => {
    source = createBrandTargetSource()
    for (const slug of SLUGS) {
      expect(source.get(slug)).toBeNull()
    }
  })

  it('does not resolve prefetch synchronously', () => {
    source = createBrandTargetSource()
    source.prefetch(SLUGS[0], 64)
    // The point of §6 item 8: the decode must not land on the calling frame, so the
    // slug is still absent immediately afterwards.
    expect(source.get(SLUGS[0])).toBeNull()
  })

  it('populates the cache from prefetch once the idle callback runs', async () => {
    source = createBrandTargetSource()
    source.prefetch(SLUGS[0], 64)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(source.get(SLUGS[0])).not.toBeNull()
  })

  it('returns the same object for repeated ensure calls', () => {
    source = createBrandTargetSource()
    const first = source.ensure(SLUGS[0], 64)
    const second = source.ensure(SLUGS[0], 64)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('supersedes a queued prefetch when ensure arrives first', async () => {
    source = createBrandTargetSource()
    source.prefetch(SLUGS[0], 64)
    const immediate = source.ensure(SLUGS[0], 128)
    expectContractShaped(immediate, 128)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The idle task must not have overwritten the 128-anchor buffer with a second
    // decode at the prefetched count.
    expect(source.get(SLUGS[0])).toBe(immediate)
  })

  it('degrades to noise rather than throwing when there is no rasteriser', () => {
    source = createBrandTargetSource()
    const count = 48
    const value = expectContractShaped(source.ensure(SLUGS[0], count), count)

    if (CAN_RASTERISE) {
      // A real glyph samples its own pixels, so the anchor count is a property of
      // the logo rather than of the particle count.
      expect(value.anchorCount).not.toBe(count)
      expect(value.strokeDepth.some((depth) => depth > 0)).toBe(true)
    } else {
      // No rasteriser: the noise fallback answers with one anchor per particle, no
      // stroke depth, and a blob around the origin — and must not throw.
      expect(value.anchorCount).toBe(count)
      expect(Array.from(value.strokeDepth).every((depth) => depth === 0)).toBe(true)
      // The mean is a sanity check on the fallback's placement, not a discriminator:
      // a uniform ball of radius 4..11 has |mean(x)| up to ~1.5 over 48 samples, so
      // the bound is loose. It still separates the fallback from a glyph, whose
      // anchors are centred on ICON_CENTER_X (5.8) and would sit far outside it.
      expect(Math.abs(meanX(value.targets, count))).toBeLessThan(2)
    }
  })

  it('returns null for a slug with no asset instead of inventing a shape', () => {
    source = createBrandTargetSource()
    expect(source.ensure('not-a-brand', 64)).toBeNull()
    expect(source.get('not-a-brand')).toBeNull()
  })

  it('rejects a nonsensical count instead of allocating for it', () => {
    source = createBrandTargetSource()
    expect(source.ensure(SLUGS[0], 0)).toBeNull()
    expect(source.ensure(SLUGS[0], -5)).toBeNull()
    expect(source.ensure(SLUGS[0], Number.NaN)).toBeNull()
    expect(source.ensure(SLUGS[0], Infinity)).toBeNull()
  })

  it('ignores prefetch for a slug with no asset', () => {
    source = createBrandTargetSource()
    source.prefetch('not-a-brand', 64)
    expect(source.get('not-a-brand')).toBeNull()
  })

  it('clears everything on dispose and cancels the pending idle work', async () => {
    source = createBrandTargetSource()
    for (const slug of SLUGS.slice(0, 3)) source.ensure(slug, 32)
    source.prefetch(SLUGS[5], 32)

    source.dispose()

    for (const slug of SLUGS) {
      expect(source.get(slug)).toBeNull()
    }
    expect(source.ensure(SLUGS[0], 32)).toBeNull()

    // A cancelled idle callback must not fire, and a stray one must not refill the
    // cache past the `disposed` guard — that would leak a whole brand after the
    // page had torn down.
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (const slug of SLUGS) {
      expect(source.get(slug)).toBeNull()
    }
  })
})
