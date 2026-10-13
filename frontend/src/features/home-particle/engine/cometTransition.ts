import { GATHER_SECONDS } from './constants'

function unit(q: number): number {
  return q > 0 ? Math.min(q, 1) : 0
}

function smooth(q: number): number {
  const t = unit(q)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** Gravity accelerates until the final eight percent, then settles with C1 continuity. */
export function collapseProgress(q: number): number {
  const t = unit(q)
  if (t === 1) return 1
  if (t <= 0.92) return t ** 3.5
  const u = (t - 0.92) / 0.08
  const start = 0.92 ** 3.5
  const tangent = 3.5 * 0.92 ** 2.5 * 0.08
  return (2 * u ** 3 - 3 * u * u + 1) * start +
    (u ** 3 - 2 * u * u + u) * tangent + (-2 * u ** 3 + 3 * u * u)
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

  // Outer glyph layers release first, with a small independent timing variation.
  const delay = 0.18 * (1 - unit(sourceRadius / 6)) + salt * 0.018
  const c = collapseProgress((t - delay) / (1 - delay))
  const cx = coreX - headX
  const cy = coreY - headY
  const cz = coreZ - headZ
  const coreRadius = Math.hypot(cx, cy, cz)
  const radius = sourceRadius + (coreRadius - sourceRadius) * c
  const sourceInverse = sourceRadius > 1e-9 ? 1 / sourceRadius : 0
  const coreInverse = coreRadius > 1e-9 ? 1 / coreRadius : 0
  const sx = x * sourceInverse, sy = y * sourceInverse, sz = z * sourceInverse
  // Preserve the original radial ray until the atom reaches the compact nucleus.
  // Only that small volume resolves the final grain position: no orbital spin,
  // shared pole, or large-radius angular sweep.
  const compact = Math.max(coreRadius * 1.35, 0.28)
  const resolveStart = Math.max(0, 1 - compact / Math.max(sourceRadius - coreRadius, compact))
  const resolve = smooth((c - resolveStart) / (1 - resolveStart))
  const dot = sx * cx * coreInverse + sy * cy * coreInverse + sz * cz * coreInverse
  // Decorrelated local bend keeps antipodal endpoints away from a zero vector.
  const ax = Math.sin(salt * 127.1 + 0.3)
  const ay = Math.cos(salt * 269.5 + 0.7)
  const az = Math.sin(salt * 183.3 + 1.1)
  const projection = ax * sx + ay * sy + az * sz
  const bend = Math.max(0, -dot) * resolve * (1 - resolve)
  const dx = sx * (1 - resolve) + cx * coreInverse * resolve + (ax - sx * projection) * bend
  const dy = sy * (1 - resolve) + cy * coreInverse * resolve + (ay - sy * projection) * bend
  const dz = sz * (1 - resolve) + cz * coreInverse * resolve + (az - sz * projection) * bend
  const length = Math.hypot(dx, dy, dz)
  const scale = length > 1e-12 ? radius / length : 0
  out[0] = headX + dx * scale
  out[1] = headY + dy * scale
  out[2] = headZ + dz * scale
  out[3] = sourceAlpha + (coreAlpha - sourceAlpha) * c
  out[4] = 1 - c
}
