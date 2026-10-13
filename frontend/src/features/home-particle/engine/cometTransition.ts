import { GATHER_SECONDS } from './constants'

function unit(q: number): number {
  return q > 0 ? Math.min(q, 1) : 0
}

function smooth(q: number): number {
  const t = unit(q)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** C1 endpoints, visible early infall, peak speed at 2/3 rather than a final snap. */
export function collapseProgress(q: number): number {
  const t = unit(q)
  return t * t * t * (4 - 3 * t)
}

/** In-place heap sort: bounded O(N log N), no comparator closures or temporary arrays. */
function sortRadii(order: Uint32Array, radii: Float64Array): void {
  const n = order.length
  for (let start = Math.floor(n / 2) - 1; start >= -n + 1; start--) {
    let root: number, end: number
    if (start >= 0) { root = start; end = n }
    else {
      end = n + start
      const swap = order[0]; order[0] = order[end]; order[end] = swap
      root = 0
    }
    const value = order[root]
    while (root * 2 + 1 < end) {
      let child = root * 2 + 1
      if (child + 1 < end && radii[order[child + 1]] > radii[order[child]]) child++
      if (radii[value] >= radii[order[child]]) break
      order[root] = order[child]
      root = child
    }
    order[root] = value
  }
}

/**
 * Phase-seam rank transport. Identity/source buffers stay untouched; each actual
 * body point is used exactly once, with its tone, size and alpha. Rotation leaves
 * the radius order invariant. Caller owns every buffer; work runs once per scatter.
 * Returns the number of endpoint-constrained local reassemblies (target > source).
 */
export function assignCometCore(
  assignment: Uint32Array, sourceOrder: Uint32Array, coreOrder: Uint32Array,
  sourceRadii: Float64Array, coreRadii: Float64Array,
  sources: ArrayLike<number>, offsets: ArrayLike<number>,
  headX: number, headY: number, headZ: number
): number {
  for (let i = 0; i < assignment.length; i++) {
    const k = i * 3
    sourceOrder[i] = coreOrder[i] = i
    sourceRadii[i] = Math.hypot(sources[k] - headX, sources[k + 1] - headY, sources[k + 2] - headZ)
    coreRadii[i] = Math.hypot(offsets[k], offsets[k + 1], offsets[k + 2])
  }
  sortRadii(sourceOrder, sourceRadii)
  sortRadii(coreOrder, coreRadii)
  let reassemblies = 0
  for (let rank = 0; rank < assignment.length; rank++) {
    const source = sourceOrder[rank], core = coreOrder[rank]
    assignment[source] = core
    if (sourceRadii[source] < coreRadii[core]) reassemblies++
  }
  return reassemblies
}

/** Actual shape commitment, separate from the frozen choreography's legacy easing API. */
export function transitionGlyphMix(phase: 'travel' | 'gather' | 'hold' | 'scatter', q: number): number {
  if (phase === 'hold') return 1
  if (phase === 'travel') return 0
  return phase === 'gather' ? smooth((q - 0.28) / 0.72) : 1 - collapseProgress(q)
}

/**
 * Stateless closed-form transition. Source and salt are latched by the caller.
 * out = [x, y, z, integrated alpha, glyph commitment, warm-fragment amount].
 * Only scalar math and writes: no arrays, vectors, closures or random draws per call.
 */
export function writeCometTransition(
  out: Float64Array,
  phase: 'gather' | 'scatter', q: number,
  sourceX: number, sourceY: number, sourceZ: number,
  glyphX: number, glyphY: number, glyphZ: number,
  coreX: number, coreY: number, coreZ: number,
  headX: number, headY: number, headZ: number,
  salt: number, sourceAlpha: number, coreAlpha: number
): void {
  const t = unit(q)
  const gather = phase === 'gather'
  out[5] = 0
  if (t === 0 || t === 1) {
    out[0] = t === 0 ? sourceX : gather ? glyphX : coreX
    out[1] = t === 0 ? sourceY : gather ? glyphY : coreY
    out[2] = t === 0 ? sourceZ : gather ? glyphZ : coreZ
    out[3] = t === 0 ? sourceAlpha : gather ? 1 : coreAlpha
    out[4] = gather ? t : 1 - t
    return
  }

  const x = sourceX - headX
  const y = sourceY - headY
  const z = sourceZ - headZ
  const sourceRadius = Math.hypot(x, y, z)
  if (gather) {
    // Surface atoms detach first, with overlapping, hashed release times. The
    // interior stays intact while nearby grains peel off; no common blast front.
    const layer = sourceRadius / (sourceRadius + 0.45)
    const delay = 0.015 + 0.15 * (1 - layer) + salt * 0.12
    const elapsed = Math.max(0, t - delay) * GATHER_SECONDS
    const azimuth = salt * 43.17 + x * 2.7 + z * 1.9
    const polar = Math.sin(salt * 71.73 + y * 3.1)
    const planar = Math.sqrt(Math.max(0, 1 - polar * polar))
    const radial = sourceRadius > 1e-9 ? 0.36 / sourceRadius : 0
    const dx = x * radial + Math.cos(azimuth) * planar
    const dy = y * radial + Math.sin(azimuth) * planar
    const dz = z * radial + polar
    const inverse = 1 / Math.hypot(dx, dy, dz)
    // Short acceleration then free drift; each atom has a detached interval
    // before glyph attraction. This cannot create a synchronised expanding shell.
    const distance = (0.9 + salt * 0.8) * (elapsed - 0.09 * (1 - Math.exp(-elapsed / 0.09)))
    const captureStart = delay + 0.23
    const capture = smooth((t - captureStart) / (1 - captureStart))
    const bx = sourceX + dx * inverse * distance
    const by = sourceY + dy * inverse * distance
    const bz = sourceZ + dz * inverse * distance
    out[0] = bx + (glyphX - bx) * capture
    out[1] = by + (glyphY - by) * capture
    out[2] = bz + (glyphZ - bz) * capture
    const released = smooth(elapsed / 0.22)
    const grainAlpha = sourceAlpha + (Math.max(sourceAlpha, 0.16 + salt * 0.1) - sourceAlpha) * released
    out[3] = grainAlpha + (1 - grainAlpha) * capture
    out[4] = capture
    return
  }

  // Outer glyph layers release first. Independent start times break the outline
  // early instead of shrinking the whole mark by a common scale.
  const delay = 0.12 * (1 - unit(sourceRadius / 6)) + salt * 0.06
  const c = collapseProgress((t - delay) / (1 - delay))
  const cx = coreX - headX
  const cy = coreY - headY
  const cz = coreZ - headZ
  const coreRadius = Math.hypot(cx, cy, cz)
  if (sourceRadius < coreRadius) {
    // Endpoint constraints forbid monotone radius here. Rank assignment confines
    // these to the innermost population. Remain in place through 65% of coalescence,
    // then reassemble inside the convex ball of radius coreRadius (no overshoot).
    const local = smooth((t - 0.65) / 0.35)
    out[0] = sourceX + (coreX - sourceX) * local
    out[1] = sourceY + (coreY - sourceY) * local
    out[2] = sourceZ + (coreZ - sourceZ) * local
  } else {
    const radius = sourceRadius + (coreRadius - sourceRadius) * c
    const sourceInverse = sourceRadius > 0 ? 1 / sourceRadius : 0
    const coreInverse = coreRadius > 0 ? 1 / coreRadius : 0
    const sx = x * sourceInverse, sy = y * sourceInverse, sz = z * sourceInverse
    const ex = cx * coreInverse, ey = cy * coreInverse, ez = cz * coreInverse
    // No angular sweep outside the target neighbourhood. Give docking a broad
    // time window inside it; quintic endpoints also stop its angular velocity.
    const compact = Math.max(coreRadius * 1.35, 0.28)
    const resolveStart = Math.max(0, 1 - compact / Math.max(sourceRadius - coreRadius, compact))
    const resolve = smooth((c - resolveStart) / (1 - resolveStart))
    const dot = Math.max(-1, Math.min(1, sx * ex + sy * ey + sz * ez))
    let ux = ex - sx * dot, uy = ey - sy * dot, uz = ez - sz * dot
    let tangentLength = Math.hypot(ux, uy, uz)
    if (tangentLength < 1e-8) {
      // At an exact antipode no unique arc exists. Pick a well-conditioned
      // tangent using the least-aligned coordinate, never normalize a tiny lerp.
      const ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz)
      const rx = ax <= ay && ax <= az ? 1 : 0
      const ry = ay < ax && ay <= az ? 1 : 0
      const rz = rx === 0 && ry === 0 ? 1 : 0
      const projection = rx * sx + ry * sy + rz * sz
      ux = rx - sx * projection; uy = ry - sy * projection; uz = rz - sz * projection
      tangentLength = Math.hypot(ux, uy, uz)
    }
    const angle = coreRadius > 0 ? Math.acos(dot) * resolve : 0
    const along = Math.cos(angle), across = Math.sin(angle) / Math.max(tangentLength, 1e-12)
    out[0] = headX + radius * (sx * along + ux * across)
    out[1] = headY + radius * (sy * along + uy * across)
    out[2] = headZ + radius * (sz * along + uz * across)
  }
  out[3] = sourceAlpha + (coreAlpha - sourceAlpha) * c
  out[4] = 1 - c
}
