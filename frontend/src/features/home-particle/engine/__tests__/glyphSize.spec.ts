/**
 * LANE LC — the V6 sizing maths: 图案高 >= 视口 2/3, 宽 >= 视口 1/3.
 *
 * What this file has to prove, and why each part is load-bearing:
 *
 *   projection   A glyph's on-screen share is `height / (2 tan(fov/2) d)`. If that
 *                identity is wrong the constant is wrong, and the only place the
 *                error would show up is a screenshot — which is not a place a
 *                regression can be caught cheaply. So it is pinned here against
 *                the closed form rather than against the implementation.
 *   floors       The returned size must clear BOTH of the user's numbers, and must
 *                sit exactly ON the binding one. A "size" that overshoots both is
 *                as wrong as one that misses: it would push the glyph off screen.
 *   inverse      `fitDistanceForGlyph` and `requiredGlyphWorldSize` are the same
 *                projection read in two directions. If they disagree, the mainline
 *                can satisfy one and silently violate the other, so they are
 *                asserted to agree rather than assumed to.
 *   robustness   A NaN FOV or a zero aspect must not produce a NaN distance. A NaN
 *                camera position blanks the canvas, and on this page the camera is
 *                driven every frame from these numbers.
 */
import { describe, expect, it } from 'vitest'
import {
  CAMERA_FOV,
  VENDOR_ICON_WORLD_SIZE,
} from '../constants'
import {
  GLYPH_BOX_SPAN,
  GLYPH_MIN_BBOX_ASPECT,
  GLYPH_MIN_HEIGHT_SHARE,
  GLYPH_MIN_WIDTH_SHARE,
  GLYPH_WORLD_HEIGHT,
  fitDistanceForGlyph,
  fitDistanceForRoster,
  requiredGlyphWorldSize,
  visibleWorldHeight,
  visibleWorldWidth,
} from '../glyphSize'

const TAN_HALF_FOV = Math.tan((CAMERA_FOV * Math.PI) / 360)

/**
 * Independent restatement of the projection, written from the frustum geometry
 * rather than reusing anything in `glyphSize.ts`: the vertical frustum at `d` is
 * `2 tan(fov/2) d` tall, and the horizontal one is that times the aspect. If the
 * module under test ever changes its convention (degrees vs radians, half vs full
 * FOV, vertical vs horizontal), this is what catches it.
 */
function projectedShare(
  glyphHeight: number,
  bboxAspect: number,
  aspect: number,
  distance: number,
  fovDeg: number
): { h: number; w: number } {
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * distance
  const glyphWidth = glyphHeight * bboxAspect
  return {
    h: glyphHeight / 2 / halfH,
    w: glyphWidth / 2 / (halfH * aspect),
  }
}

/** Every viewport the acceptance probe measures, plus the two from the brief. */
const VIEWPORTS: Array<[string, number]> = [
  ['1440x900 desktop (brief)', 1440 / 900],
  ['390x844 phone (brief)', 390 / 844],
  ['1920x1080 desktop', 1920 / 1080],
  ['2560x1440 desktop', 2560 / 1440],
  ['1024x1366 tablet portrait', 1024 / 1366],
  ['360x640 phone', 360 / 640],
]

describe('the glyph world size is derived from the projection', () => {
  it('pins the frustum against the closed form', () => {
    // 2 * tan(22 deg) * 20, computed from the geometry rather than the module.
    const d = 20
    expect(visibleWorldHeight(d)).toBeCloseTo(2 * TAN_HALF_FOV * d, 12)
    expect(visibleWorldWidth(d, 16 / 9)).toBeCloseTo(2 * TAN_HALF_FOV * d * (16 / 9), 12)
  })

  it('agrees with an independently written projection', () => {
    for (const distance of [8, 18.712, 40, 120]) {
      for (const [, aspect] of VIEWPORTS) {
        for (const bboxAspect of [GLYPH_MIN_BBOX_ASPECT, 1, 1.634]) {
          const size = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, bboxAspect)
          const truth = projectedShare(
            size.height,
            bboxAspect,
            aspect,
            distance,
            CAMERA_FOV
          )
          expect(size.heightShare).toBeCloseTo(truth.h, 10)
          expect(size.widthShare).toBeCloseTo(truth.w, 10)
        }
      }
    }
  })

  it('reads the box span off the vendor mapping instead of restating 10.08', () => {
    // The design height is a decision, but it is anchored to the vendor's own
    // canvas->world ratio: the tallest possible mark is the full 24x24 viewBox
    // drawn into the sampler's 80% box.
    expect(GLYPH_BOX_SPAN).toBeCloseTo(0.8, 12)
    expect(GLYPH_WORLD_HEIGHT).toBeCloseTo(VENDOR_ICON_WORLD_SIZE * 0.8, 12)
    expect(GLYPH_WORLD_HEIGHT).toBeCloseTo(10.08, 12)
  })
})

describe('requiredGlyphWorldSize clears both of the user floors', () => {
  it('is a floor, not a target: both shares are at or above the numbers', () => {
    // The distance from the brief's own derivation: the one that puts a levelled
    // mark on 2/3 of the height.
    const distance = (GLYPH_WORLD_HEIGHT * 3) / (4 * TAN_HALF_FOV)
    for (const [name, aspect] of VIEWPORTS) {
      const size = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, GLYPH_MIN_BBOX_ASPECT)
      expect(size.heightShare, `${name} height`).toBeGreaterThanOrEqual(
        GLYPH_MIN_HEIGHT_SHARE - 1e-9
      )
      expect(size.widthShare, `${name} width`).toBeGreaterThanOrEqual(
        GLYPH_MIN_WIDTH_SHARE - 1e-9
      )
    }
  })

  it('sits exactly on the binding floor and strictly above the other', () => {
    const distance = 18.712
    for (const [name, aspect] of VIEWPORTS) {
      for (const bboxAspect of [GLYPH_MIN_BBOX_ASPECT, 1]) {
        const size = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, bboxAspect)
        const onFloor =
          size.binding === 'height'
            ? Math.abs(size.heightShare - GLYPH_MIN_HEIGHT_SHARE)
            : Math.abs(size.widthShare - GLYPH_MIN_WIDTH_SHARE)
        // Landing on the floor is what keeps the glyph as small as it may be: an
        // oversized glyph is as much a failure as an undersized one, because it
        // runs off the viewport at the extremes.
        expect(onFloor, `${name} bbox ${bboxAspect} binding ${size.binding}`).toBeLessThan(1e-9)
        const other =
          size.binding === 'height' ? size.widthShare : size.heightShare
        const otherFloor =
          size.binding === 'height' ? GLYPH_MIN_WIDTH_SHARE : GLYPH_MIN_HEIGHT_SHARE
        expect(other).toBeGreaterThanOrEqual(otherFloor - 1e-9)
      }
    }
  })

  it('scales inversely with distance, as a perspective projection must', () => {
    const near = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 10, 1)
    const far = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 20, 1)
    // Twice the distance needs twice the glyph for the same share.
    expect(far.height / near.height).toBeCloseTo(2, 10)
    expect(far.heightShare).toBeCloseTo(near.heightShare, 10)
  })

  it('does not let a bbox aspect move the share it is not about', () => {
    // A taller bbox aspect needs a bigger number for the WIDTH floor, and that can
    // only ever raise the height requirement — never lower it below 2/3.
    const square = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 18.712, 1)
    const wide = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 18.712, 1.6)
    expect(wide.height).toBeGreaterThanOrEqual(square.height - 1e-12)
    expect(wide.heightShare).toBeGreaterThanOrEqual(GLYPH_MIN_HEIGHT_SHARE - 1e-9)
    expect(wide.widthShare).toBeGreaterThanOrEqual(GLYPH_MIN_WIDTH_SHARE - 1e-9)
  })

  it('reports the width floor as binding on a wide viewport with a narrow glyph', () => {
    // 2/3 tall and 1/3 wide cannot both hold for a 0.7-aspect mark on a 1.6-aspect
    // viewport: 2/3 * 0.7 / 1.6 is under a third. The height has to rise, and the
    // reported binding says so rather than the caller having to guess.
    const size = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 18.712, 0.7)
    expect(size.binding).toBe('width')
    expect(size.widthShare).toBeCloseTo(GLYPH_MIN_WIDTH_SHARE, 9)
    expect(size.heightShare).toBeGreaterThan(GLYPH_MIN_HEIGHT_SHARE)
  })
})

describe('fitDistanceForGlyph inverts requiredGlyphWorldSize', () => {
  it('is the boundary: at it the floors hold, just past it they fail', () => {
    for (const [, aspect] of VIEWPORTS) {
      for (const bboxAspect of [GLYPH_MIN_BBOX_ASPECT, 1]) {
        const distance = fitDistanceForGlyph(
          GLYPH_WORLD_HEIGHT,
          aspect,
          CAMERA_FOV,
          bboxAspect
        )
        const onIt = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, bboxAspect)
        const heightBefore = requiredGlyphWorldSize(
          aspect,
          CAMERA_FOV,
          distance * 0.99,
          bboxAspect
        )
        const heightAfter = requiredGlyphWorldSize(
          aspect,
          CAMERA_FOV,
          distance * 1.01,
          bboxAspect
        )
        expect(onIt.height).toBeCloseTo(GLYPH_WORLD_HEIGHT, 9)
        // Nearer camera, smaller required glyph; further camera, bigger required
        // glyph. Monotone in the direction the geometry demands.
        expect(heightBefore.height).toBeLessThan(GLYPH_WORLD_HEIGHT)
        expect(heightAfter.height).toBeGreaterThan(GLYPH_WORLD_HEIGHT)
      }
    }
  })

  it('holds both floors for the whole roster at the roster distance', () => {
    for (const [name, aspect] of VIEWPORTS) {
      const distance = fitDistanceForRoster(aspect)
      // Worst bbox aspect in the roster, at the distance the roster is fitted to:
      // this is the binding case, so it is the one that must not fail.
      const worst = requiredGlyphWorldSize(
        aspect,
        CAMERA_FOV,
        distance,
        GLYPH_MIN_BBOX_ASPECT
      )
      expect(worst.heightShare, `${name} height`).toBeGreaterThanOrEqual(
        GLYPH_MIN_HEIGHT_SHARE - 1e-9
      )
      expect(worst.widthShare, `${name} width`).toBeGreaterThanOrEqual(
        GLYPH_MIN_WIDTH_SHARE - 1e-9
      )
      // And every wider mark is easier on the width floor while needing the same
      // height, so a square one passes too.
      const square = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, 1)
      expect(square.heightShare, `${name} square height`).toBeGreaterThanOrEqual(
        GLYPH_MIN_HEIGHT_SHARE - 1e-9
      )
      expect(square.widthShare, `${name} square width`).toBeGreaterThanOrEqual(
        GLYPH_MIN_WIDTH_SHARE - 1e-9
      )
    }
  })

  it('fits a portrait viewport by the height, and a wide one by the width', () => {
    // Height binds on a phone (width is free there — a h=2/3 glyph is already
    // wider than 1/3); width binds on a landscape viewport with a narrow mark.
    const phone = fitDistanceForRoster(390 / 844)
    const phoneHeightOnly = fitDistanceForGlyph(
      GLYPH_WORLD_HEIGHT,
      390 / 844,
      CAMERA_FOV,
      GLYPH_MIN_BBOX_ASPECT
    )
    expect(phone).toBeCloseTo(phoneHeightOnly, 9)

    const desktop = fitDistanceForRoster(1440 / 900)
    const heightFloor = (GLYPH_WORLD_HEIGHT * 3) / (4 * TAN_HALF_FOV)
    expect(desktop).toBeLessThan(heightFloor)
  })
})

describe('the two brief viewports, worked through end to end', () => {
  /**
   * The numbers the brief asks for, derived rather than quoted: at the roster
   * distance, project the levelled glyph back to pixels and compare with the
   * floors. This is the same arithmetic the acceptance probe does, so if these
   * pass and the probe fails, the engine is not honouring the distance.
   */
  const cases: Array<[string, number, number, number]> = [
    ['1440x900', 1440, 900, 1440 / 900],
    ['390x844', 390, 844, 390 / 844],
  ]

  it('clears both floors on 1440x900 and 390x844', () => {
    for (const [name, vw, vh, aspect] of cases) {
      const distance = fitDistanceForRoster(aspect)
      const size = requiredGlyphWorldSize(
        aspect,
        CAMERA_FOV,
        distance,
        GLYPH_MIN_BBOX_ASPECT
      )
      const visibleH = visibleWorldHeight(distance)
      const visibleW = visibleWorldWidth(distance, aspect)
      // Project to pixels the way the probe does, then take the fraction.
      const pxH = (size.height / visibleH) * vh
      const pxW = (size.width / visibleW) * vw
      expect(pxH / vh, `${name} height`).toBeGreaterThanOrEqual(GLYPH_MIN_HEIGHT_SHARE - 1e-9)
      expect(pxW / vw, `${name} width`).toBeGreaterThanOrEqual(GLYPH_MIN_WIDTH_SHARE - 1e-9)
      // And the pixel count is a real, positive number of pixels rather than a
      // rounding artefact.
      expect(pxH).toBeGreaterThan(vh * 0.6)
      expect(pxW).toBeGreaterThan(vw * 0.3)
      expect(Number.isFinite(distance)).toBe(true)
    }
  })

  it('needs a nearer camera on a wide viewport than on a tall one', () => {
    // At a fixed world size the horizontal frustum grows with the aspect, so a wide
    // viewport puts the same glyph on a smaller share and needs the camera closer.
    expect(fitDistanceForRoster(1440 / 900)).toBeLessThan(fitDistanceForRoster(390 / 844))
  })
})

describe('degenerate inputs produce usable numbers, never NaN', () => {
  it('falls back to the frozen FOV for a bad one', () => {
    const good = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, 20, 1)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -44, 180, 360]) {
      const size = requiredGlyphWorldSize(16 / 9, bad, 20, 1)
      expect(Number.isFinite(size.height), `fov ${bad}`).toBe(true)
      expect(size.height).toBeCloseTo(good.height, 9)
      // The inverse must make the same substitution, or the two would disagree for
      // exactly the inputs nobody tests by hand.
      expect(fitDistanceForGlyph(GLYPH_WORLD_HEIGHT, 16 / 9, bad, 1)).toBeCloseTo(
        fitDistanceForGlyph(GLYPH_WORLD_HEIGHT, 16 / 9, CAMERA_FOV, 1),
        9
      )
    }
  })

  it('keeps a non-positive distance from collapsing the shares', () => {
    for (const bad of [0, -20, Number.NaN]) {
      const size = requiredGlyphWorldSize(16 / 9, CAMERA_FOV, bad, 1)
      expect(Number.isFinite(size.height)).toBe(true)
      expect(size.height).toBeGreaterThan(0)
      expect(size.heightShare).toBeCloseTo(GLYPH_MIN_HEIGHT_SHARE, 9)
    }
  })

  it('keeps a non-positive aspect or bbox aspect usable', () => {
    for (const bad of [0, -1.6, Number.NaN]) {
      const size = requiredGlyphWorldSize(bad, CAMERA_FOV, 20, bad)
      expect(Number.isFinite(size.height)).toBe(true)
      expect(size.heightShare).toBeGreaterThanOrEqual(GLYPH_MIN_HEIGHT_SHARE - 1e-9)
      expect(Number.isFinite(fitDistanceForRoster(bad))).toBe(true)
      expect(fitDistanceForRoster(bad)).toBeGreaterThan(0)
    }
  })

  it('always returns a size the floors would accept, on any input', () => {
    // Sweep: whatever the numbers, the answer must be self-consistent — the
    // returned height, projected at the distance the answer was derived for, is
    // what the returned shares say it is.
    for (const aspect of [0.3, 0.462, 1, 1.6, 3.5]) {
      for (const distance of [0.05, 1, 18.712, 500]) {
        for (const bboxAspect of [0.2, 0.7, 1, 2.5]) {
          const size = requiredGlyphWorldSize(aspect, CAMERA_FOV, distance, bboxAspect)
          const truth = projectedShare(size.height, bboxAspect, aspect, distance, CAMERA_FOV)
          expect(Number.isFinite(size.height)).toBe(true)
          expect(size.heightShare).toBeCloseTo(truth.h, 10)
          expect(size.widthShare).toBeCloseTo(truth.w, 10)
        }
      }
    }
  })
})
