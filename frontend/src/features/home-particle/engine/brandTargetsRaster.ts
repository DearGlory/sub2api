/** Shared by synchronous ensure and the prefetch worker; no DOM parsing here. */
import {
  VOXSPACE_ICON_MASK_ALPHA,
  buildVoxSpaceIconTargets,
} from '../vendor/voxspace-icon-targets'
import { ICON_CENTER_X } from '../vendor/voxspace-math'
import { GLYPH_WORLD_HEIGHT } from './glyphSize'
import type { BrandTargets } from './types'

export interface GlyphEllipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** Structured-cloneable geometry; DOMParser is unavailable in workers. */
export interface GlyphSource {
  viewBox: [number, number, number, number]
  paths: string[]
  ellipses: GlyphEllipse[]
  fillRule: 'evenodd' | 'nonzero'
}

export interface BrandTargetsRequest {
  id: number
  slug: string
  source: GlyphSource
  count: number
  canvasSize: number
}

export interface BrandTargetsResponse {
  id: number
  slug: string
  result: BrandTargets | null
}

type GlyphCanvas = HTMLCanvasElement | OffscreenCanvas

/** Same Path2D fill, transform and alpha read for both kinds of canvas. */
export function rasteriseGlyphMask(
  source: GlyphSource,
  size: number,
  canvas: GlyphCanvas
): Uint8Array | null {
  try {
    if (typeof Path2D === 'undefined') return null
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null

    const outline = new Path2D()
    for (const d of source.paths) outline.addPath(new Path2D(d))
    for (const { cx, cy, rx, ry } of source.ellipses) {
      outline.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    }
    const [minX, minY, viewBoxWidth, viewBoxHeight] = source.viewBox
    const inset = size * 0.1
    const span = size * 0.8
    const scaleX = span / viewBoxWidth
    const scaleY = span / viewBoxHeight
    ctx.setTransform(scaleX, 0, 0, scaleY, inset - minX * scaleX, inset - minY * scaleY)
    ctx.fillStyle = '#ffffff'
    ctx.fill(outline, source.fillRule)
    ctx.setTransform(1, 0, 0, 1, 0, 0)

    const pixels = ctx.getImageData(0, 0, size, size).data
    const mask = new Uint8Array(size * size)
    for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3]
    return mask
  } catch {
    return null
  } finally {
    // Release the backing store even after an invalid path or lost context.
    canvas.width = 0
    canvas.height = 0
  }
}

/** Diagnostic count uses the vendor's unchanged three-pixel anchor walk. */
function countMaskAnchors(mask: Uint8Array, size: number): number {
  let anchors = 0
  for (let y = 0; y < size; y += 3) {
    const row = y * size
    for (let x = 0; x < size; x += 3) {
      if (mask[row + x] > VOXSPACE_ICON_MASK_ALPHA) anchors++
    }
  }
  return anchors
}

/** Uniform scale about the glyph centre; stroke depth is a world distance too. */
function levelToGlyphHeight(targets: Float32Array, strokeDepth: Float32Array): void {
  let min = Infinity
  let max = -Infinity
  for (let i = 1; i < targets.length; i += 3) {
    const y = targets[i]
    if (y < min) min = y
    if (y > max) max = y
  }
  const height = max - min
  if (!Number.isFinite(height) || height <= 0) return
  const scale = GLYPH_WORLD_HEIGHT / height
  if (!Number.isFinite(scale) || scale <= 0) return
  for (let i = 0; i < targets.length; i += 3) {
    targets[i] = ICON_CENTER_X + (targets[i] - ICON_CENTER_X) * scale
    targets[i + 1] *= scale
    targets[i + 2] *= scale
  }
  for (let i = 0; i < strokeDepth.length; i++) strokeDepth[i] *= scale
}

/** No result escapes until raster, sampler and height levelling all finish. */
export function buildGlyphTargets(
  source: GlyphSource,
  count: number,
  canvasSize: number,
  canvas: GlyphCanvas
): BrandTargets | null {
  const mask = rasteriseGlyphMask(source, canvasSize, canvas)
  if (!mask || mask.length !== canvasSize * canvasSize) return null
  const sampled = buildVoxSpaceIconTargets(mask, canvasSize, count)
  if (!sampled) return null
  levelToGlyphHeight(sampled.targets, sampled.strokeDepth)
  return {
    targets: sampled.targets,
    strokeDepth: sampled.strokeDepth,
    anchorCount: countMaskAnchors(mask, canvasSize),
  }
}
