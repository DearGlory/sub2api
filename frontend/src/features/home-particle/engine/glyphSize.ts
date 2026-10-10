/**
 * LANE LC — how big the glyph must be in world units, and how far the camera may
 * sit, for V6.
 *
 * [user] 散开组成的图案太小了，高度最少要网页的三分之二，宽度最少要网页的三分之一
 *
 * Pure and DOM-free: no three.js, no viewport, no engine state. Two directions of
 * one projection, so the mainline can ask either question —
 *
 *   requiredGlyphWorldSize(aspect, fovDeg, distance, glyphAspect)
 *     "the camera sits here; how big must the glyph be?"
 *
 *   fitDistanceForGlyph(glyphHeight, aspect, fovDeg, glyphAspect)
 *     "the glyph is this big; where must the camera sit?"
 *
 * The projection
 * --------------
 * three.js `PerspectiveCamera` takes the vertical FOV, so the frustum's world
 * height at a distance `d` is
 *
 *   visibleH(d) = 2 * tan(fov / 2) * d
 *
 * and its world width is that times the aspect. A glyph whose own bounding-box
 * height is `h` therefore projects to
 *
 *   heightShare = h / visibleH(d)
 *   widthShare  = (h * glyphAspect) / visibleW(d)
 *
 * where `glyphAspect` is the glyph's own bbox width / height — a square mark is 1,
 * a wordmark-ish mark is > 1, and a tall mark is < 1. It is a parameter rather
 * than a constant because the roster is not one shape: the measured extents run
 * from 0.70 (a tall mark) to 1.63 (a wide one).
 *
 * Which floor binds
 * -----------------
 * The two numbers the user gave are separate constraints on two different
 * quantities, and they do not bite equally. Solving each for `d`:
 *
 *   height floor:  d <= h / (2 tan (fov/2) * MIN_HEIGHT_SHARE)
 *   width  floor:  d <= h * glyphAspect / (2 tan (fov/2) * aspect * MIN_WIDTH_SHARE)
 *
 * Smaller `d` means a bigger projection, so "clear both floors" is "be at or
 * inside BOTH distances", i.e. `d <= min(...)`. The binding floor is the one that
 * yields the smaller distance. On a landscape viewport with a square glyph the
 * height floor binds; on a landscape viewport with a NARROW glyph the width floor
 * binds instead, and the glyph then has to be taller than 2/3 to be wide enough.
 * That is not a bug in the maths, it is the geometry: a 0.70-aspect mark cannot be
 * 2/3 as tall as the viewport and only 1/3 as wide, because 2/3 * 0.70 / 1.6 is
 * under a third.
 *
 * Why the glyph is levelled rather than the distance being per-brand
 * -----------------------------------------------------------------
 * The on-screen share is `h / visibleH(d)`, so with a FIXED `h` one camera
 * distance serves the whole roster and every brand lands on the same share. Left
 * at the vendor's own normalisation there is no such distance: the 28 logos
 * rasterise to bbox heights of 6.06..9.96 world units (measured over the roster),
 * a 1.64x spread, so a distance chosen to put the shortest mark at 2/3 puts the
 * tallest at 110% — clipped — and a distance chosen for the tallest leaves the
 * shortest at 41%, under two thirds of the way to the floor. Levelling each glyph
 * to `GLYPH_WORLD_HEIGHT` collapses that spread to zero, which is what turns V6
 * from unsatisfiable into a single distance. `brandTargets.ts` does the levelling
 * and scales `strokeDepth` by the same factor, because stroke depth is a world
 * unit distance and a uniform world scale has to carry it or the internal flow
 * loses its dimension.
 */
import { CAMERA_FOV, VENDOR_ICON_WORLD_SIZE } from './constants'

/** [user] 高度最少要网页的三分之二. A floor, not a target — over-shooting is allowed. */
export const GLYPH_MIN_HEIGHT_SHARE = 2 / 3
/** [user] 宽度最少要网页的三分之一. A floor as well. */
export const GLYPH_MIN_WIDTH_SHARE = 1 / 3

/**
 * The share of the vendor's icon box a glyph is actually drawn into.
 *
 * `brandTargets.ts` rasterises the artefact into the central 80% of the canvas
 * (`ICON_DRAW_INSET` 0.1, `ICON_DRAW_SPAN` 0.8) and the sampler maps that canvas
 * one-to-one onto `VOXSPACE_ICON_WORLD_SIZE` = 12.6. Restated here rather than
 * imported because the two files live in different families (the sampler owns the
 * draw box, this one owns the design size) and a silent change to either has to be
 * caught by a test rather than by a shared constant quietly moving both.
 */
export const GLYPH_BOX_SPAN = 0.8

/**
 * The world height every glyph is levelled to: the tallest box the sampler can
 * deliver, i.e. a mark that fills its 24x24 viewBox to top and bottom.
 *
 * 12.6 * 0.8 = 10.08. Expressed as a product instead of the literal so the
 * relationship to the vendor's mapping stays visible — `VENDOR_ICON_WORLD_SIZE`
 * keeps its meaning (canvas pixels -> world units) and is not being redefined;
 * this is the separate decision of how tall the finished mark should be.
 */
export const GLYPH_WORLD_HEIGHT = VENDOR_ICON_WORLD_SIZE * GLYPH_BOX_SPAN

/**
 * The narrowest bbox width/height ratio in the roster.
 *
 * Measured off the brand probe's per-slug `extentX`/`extentY` at the frozen 760 px
 * canvas: the minimum is 0.699 (groq, 5.84 x 8.36), the maximum 1.634
 * (xiaomimimo, 9.90 x 6.06). The floor is taken at 0.70 so the width-bound case is
 * honoured by whatever the mainline computes from this one number, without needing
 * to know which brand is on screen. A glyph narrower than this would want a camera
 * nearer than the roster fit provides; nothing in the shipped roster is.
 */
export const GLYPH_MIN_BBOX_ASPECT = 0.7

/** Vertical half-FOV in radians, from a vertical FOV in degrees. */
function halfFovRadians(fovDeg: number): number {
  // A non-finite or degenerate FOV would make every distance in this file NaN,
  // which the engine would then read as a NaN camera position and blank the canvas.
  // Falling back to the frozen constant is the honest failure: the numbers stay
  // usable and the caller's own value is the only thing ignored.
  const fov = Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180 ? fovDeg : CAMERA_FOV
  return (fov * Math.PI) / 360
}

/** A distance must be a positive finite length for any of the shares to mean anything. */
function usableDistance(distance: number): number {
  return Number.isFinite(distance) && distance > 0 ? distance : Number.EPSILON
}

/** A bbox aspect must be a positive finite ratio; a zero would divide the width away. */
function usableAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1
}

/** World height of the camera frustum at `distance`, for a vertical `fovDeg`. */
export function visibleWorldHeight(
  distance: number,
  fovDeg: number = CAMERA_FOV
): number {
  return 2 * Math.tan(halfFovRadians(fovDeg)) * usableDistance(distance)
}

/** World width of the camera frustum at `distance`: the height times the aspect. */
export function visibleWorldWidth(
  distance: number,
  aspect: number,
  fovDeg: number = CAMERA_FOV
): number {
  return visibleWorldHeight(distance, fovDeg) * usableAspect(aspect)
}

/** Which of the user's two floors is doing the work. `'height'` when it alone bites. */
export type GlyphSizeBinding = 'height' | 'width'

export interface GlyphWorldSize {
  /** The glyph's bounding-box height the floors demand, in world units. */
  height: number
  /** The glyph's bounding-box width at that height: `height * bboxAspect`. */
  width: number
  /** `height / visibleWorldHeight(distance)` — the share of the viewport it fills. */
  heightShare: number
  /** `width / visibleWorldWidth(distance, aspect)`. */
  widthShare: number
  /** The floor that forced the size. Diagnostic, and the reason the numbers read as they do. */
  binding: GlyphSizeBinding
}

/**
 * The smallest glyph whose on-screen box clears BOTH floors at `distance`.
 *
 * Returns the size that lands exactly on the binding floor, so both `heightShare`
 * and `widthShare` are >= the user's numbers and at least one of them is equal to
 * its floor. Any glyph larger also passes; any glyph smaller fails one of them.
 *
 * `bboxAspect` is the glyph's own width / height. It defaults to 1 (a square mark),
 * which is what the majority of the roster is; pass `GLYPH_MIN_BBOX_ASPECT` for the
 * worst case over the whole roster.
 */
export function requiredGlyphWorldSize(
  aspect: number,
  fovDeg: number,
  distance: number,
  bboxAspect: number = 1
): GlyphWorldSize {
  const a = usableAspect(aspect)
  const glyphAspect = usableAspect(bboxAspect)
  const visibleH = visibleWorldHeight(distance, fovDeg)
  const visibleW = visibleH * a

  // Each floor expressed as a required bbox HEIGHT, which is the single dimension
  // the two constraints can be compared in.
  const heightForHeightFloor = GLYPH_MIN_HEIGHT_SHARE * visibleH
  // width floor: h * glyphAspect / visibleW >= MIN_WIDTH_SHARE
  const widthForWidthFloor = GLYPH_MIN_WIDTH_SHARE * visibleW
  const heightForWidthFloor = widthForWidthFloor / glyphAspect

  const binding: GlyphSizeBinding =
    heightForHeightFloor >= heightForWidthFloor ? 'height' : 'width'
  const height = Math.max(heightForHeightFloor, heightForWidthFloor)
  const width = height * glyphAspect

  return {
    height,
    width,
    heightShare: height / visibleH,
    widthShare: width / visibleW,
    binding,
  }
}

/**
 * The inverse: the largest camera-to-subject distance at which a glyph of
 * `glyphHeight` world units still clears both floors.
 *
 * "Largest" because smaller is always safer (a nearer camera only ever makes the
 * projection bigger), so this is the boundary the mainline should not cross —
 * subtracting the subject plane offset is the caller's job, since
 * `requiredGlyphWorldSize` and this function both reason about the camera-to-
 * CONTENT distance and not about either z position on its own.
 */
export function fitDistanceForGlyph(
  glyphHeight: number,
  aspect: number,
  fovDeg: number,
  bboxAspect: number = 1
): number {
  const tan = Math.tan(halfFovRadians(fovDeg))
  const a = usableAspect(aspect)
  const glyphAspect = usableAspect(bboxAspect)
  const h = Number.isFinite(glyphHeight) && glyphHeight > 0 ? glyphHeight : GLYPH_WORLD_HEIGHT

  const forHeight = h / (2 * tan * GLYPH_MIN_HEIGHT_SHARE)
  const forWidth =
    (h * glyphAspect) / (2 * tan * a * GLYPH_MIN_WIDTH_SHARE)
  return Math.min(forHeight, forWidth)
}

/**
 * The one distance that serves the whole roster, given a viewport.
 *
 * Uses the levelled `GLYPH_WORLD_HEIGHT` and the roster's narrowest bbox aspect, so
 * it is the worst case over both the brands and the two floors — every brand then
 * lands at or above both of the user's numbers at this distance, and the narrowest
 * brand is the one sitting exactly on a floor.
 */
export function fitDistanceForRoster(
  aspect: number,
  fovDeg: number = CAMERA_FOV
): number {
  return fitDistanceForGlyph(
    GLYPH_WORLD_HEIGHT,
    aspect,
    fovDeg,
    GLYPH_MIN_BBOX_ASPECT
  )
}
