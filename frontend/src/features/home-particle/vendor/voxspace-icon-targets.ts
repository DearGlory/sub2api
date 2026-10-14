/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import {
  ICON_CENTER_X,
  VOXSPACE_ICON_ANCHOR_THICKNESS,
  getVoxSpaceIconAnchorDepth,
} from './voxspace-math'

// The canvas every icon is rasterised on (the icon is drawn into its middle 80%),
// and the alpha the glyph mask cuts at. Exported because the mask fixture the
// silhouette test replays was dumped with exactly these.
export const VOXSPACE_ICON_CANVAS_SIZE = 760
export const VOXSPACE_ICON_MASK_ALPHA = 24

// Side of the square the glyph is drawn into, in world units: the canvas maps
// one-to-one onto this box, which is what turns a pixel measurement (a stroke
// width, a distance to the outline) into a distance the flow can use.
export const VOXSPACE_ICON_WORLD_SIZE = 12.6
// Anchor grid, in canvas pixels: the glyph is walked every third pixel.
const ICON_MASK_STEP = 3

// The chamfer saturates here: a stroke is never this thick, and a bounded field
// keeps the per-anchor depth readout an array read instead of a search.
const OUTLINE_CHAMFER_ORTHOGONAL = 3
const OUTLINE_CHAMFER_DIAGONAL = 4
const OUTLINE_CHAMFER_LIMIT = 48

export interface VoxSpaceIconTargets {
  targets: Float32Array
  // Per particle: how far its anchor sits from the nearest stroke edge, in world
  // units (0 on the outline, larger in the middle of a stroke). The flow reads it
  // to keep the in-plane part of the orbit on the particle's own stroke.
  strokeDepth: Float32Array
}

// Chamfer distance, in pixels, from every pixel to the nearest seed pixel
// (`seeds[i] > VOXSPACE_ICON_MASK_ALPHA`). The anchor set calls it on the inverted
// glyph mask, so a pixel inside the glyph reads its distance out to the nearest
// stroke edge; the silhouette regression calls it on the glyph mask itself, so a
// displaced pixel reads how far it has left the glyph. One field, read from both
// sides of the outline.
export function fillVoxSpaceOutlineDistance(
  seeds: Uint8Array,
  size: number,
  out: Float32Array
): void {
  const total = size * size
  const limit = (OUTLINE_CHAMFER_LIMIT + 1) * OUTLINE_CHAMFER_ORTHOGONAL

  for (let i = 0; i < total; i++) {
    out[i] = seeds[i] > VOXSPACE_ICON_MASK_ALPHA ? 0 : limit
  }

  // Forward pass: only the neighbours already visited (left, up, and the two
  // diagonals above the current row) can shorten a value.
  for (let y = 0; y < size; y++) {
    const row = y * size
    const above = row - size
    for (let x = 0; x < size; x++) {
      const i = row + x
      let value = out[i]
      if (y > 0) {
        const up = out[above + x] + OUTLINE_CHAMFER_ORTHOGONAL
        if (up < value) value = up
        if (x > 0) {
          const diagonal = out[above + x - 1] + OUTLINE_CHAMFER_DIAGONAL
          if (diagonal < value) value = diagonal
        }
        if (x + 1 < size) {
          const diagonal = out[above + x + 1] + OUTLINE_CHAMFER_DIAGONAL
          if (diagonal < value) value = diagonal
        }
      }
      if (x > 0) {
        const left = out[i - 1] + OUTLINE_CHAMFER_ORTHOGONAL
        if (left < value) value = left
      }
      out[i] = value
    }
  }

  // Backward pass: the mirror image, which is what makes the chamfer two-sided
  // instead of biased towards the top left corner.
  for (let y = size - 1; y >= 0; y--) {
    const row = y * size
    const below = row + size
    for (let x = size - 1; x >= 0; x--) {
      const i = row + x
      let value = out[i]
      if (y + 1 < size) {
        const down = out[below + x] + OUTLINE_CHAMFER_ORTHOGONAL
        if (down < value) value = down
        if (x > 0) {
          const diagonal = out[below + x - 1] + OUTLINE_CHAMFER_DIAGONAL
          if (diagonal < value) value = diagonal
        }
        if (x + 1 < size) {
          const diagonal = out[below + x + 1] + OUTLINE_CHAMFER_DIAGONAL
          if (diagonal < value) value = diagonal
        }
      }
      if (x + 1 < size) {
        const right = out[i + 1] + OUTLINE_CHAMFER_ORTHOGONAL
        if (right < value) value = right
      }
      out[i] = value
    }
  }

  // The 3-4-5 weights accumulate whole numbers; the field is contracted to pixels
  // so its two callers can both reason in one unit.
  for (let i = 0; i < total; i++) {
    out[i] /= OUTLINE_CHAMFER_ORTHOGONAL
  }
}

// Turns a glyph mask into the anchor set the particles land on, plus the stroke
// depth of every anchor. Shared by the component (which rasterises the icon PNG
// onto a canvas and hands the alpha over) and by the tests (which replay a dumped
// mask), so both sample the same way instead of keeping two samplers in step.
export function buildVoxSpaceIconTargets(
  mask: Uint8Array,
  size: number,
  count: number,
  random: () => number = Math.random
): VoxSpaceIconTargets | null {
  const total = size * size
  const outline = new Float32Array(total)
  const outside = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    outside[i] = mask[i] > VOXSPACE_ICON_MASK_ALPHA ? 0 : 255
  }
  fillVoxSpaceOutlineDistance(outside, size, outline)

  const center = size / 2
  const points: Array<{
    x: number
    y: number
    z: number
    order: number
    depth: number
  }> = []
  for (let y = 0; y < size; y += ICON_MASK_STEP) {
    for (let x = 0; x < size; x += ICON_MASK_STEP) {
      const index = y * size + x
      if (mask[index] <= VOXSPACE_ICON_MASK_ALPHA) continue
      const nx = (x - center) / size
      const ny = -(y - center) / size
      const angle = Math.atan2(ny, nx)
      const radius = Math.hypot(nx, ny)
      points.push({
        x: nx * VOXSPACE_ICON_WORLD_SIZE + ICON_CENTER_X,
        y: ny * VOXSPACE_ICON_WORLD_SIZE,
        z: getVoxSpaceIconAnchorDepth(angle, radius),
        // Walking the glyph by angle makes the sample order a stroke order:
        // neighbours in the list are neighbours on the outline.
        order: angle + radius * 4.0,
        depth: outline[index] * (VOXSPACE_ICON_WORLD_SIZE / size),
      })
    }
  }

  if (points.length === 0) {
    return null
  }
  points.sort((a, b) => a.order - b.order)

  const targets = new Float32Array(count * 3)
  const strokeDepth = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const point =
      points[Math.floor((i / count) * points.length) % points.length]
    const jitter = (random() - 0.5) * 0.035
    targets[i * 3] = point.x + jitter
    targets[i * 3 + 1] = point.y + jitter
    targets[i * 3 + 2] =
      point.z + (random() - 0.5) * VOXSPACE_ICON_ANCHOR_THICKNESS * 2
    strokeDepth[i] = point.depth
  }

  return { targets, strokeDepth }
}

// Fallback for an icon whose canvas or mask is unusable. A field with no glyph
// keeps the noise it used to get, and no stroke depth to spend on a flow that has
// no outline to respect.
export function createVoxSpaceNoiseIconTargets(
  count: number
): VoxSpaceIconTargets {
  const targets = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const radius = 4 + Math.random() * 7
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    targets[i * 3] = Math.sin(phi) * Math.cos(theta) * radius
    targets[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * radius
    targets[i * 3 + 2] = Math.cos(phi) * radius * 0.64
  }

  return { targets, strokeDepth: new Float32Array(count) }
}
