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
    // Fixed radial launch directions come from the hashed volume samples, never
    // the glyph. The rare central sample gets a deterministic volumetric direction.
    const azimuth = salt * 43.17
    const polar = Math.sin(salt * 71.73)
    const planar = Math.sqrt(1 - polar * polar)
    const dx = sourceRadius > 1e-9 ? x / sourceRadius : Math.cos(azimuth) * planar
    const dy = sourceRadius > 1e-9 ? y / sourceRadius : Math.sin(azimuth) * planar
    const dz = sourceRadius > 1e-9 ? z / sourceRadius : polar
    const elapsed = t * GATHER_SECONDS
    const powered = Math.min(elapsed, GATHER_SECONDS * 0.25)
    const coast = Math.max(0, elapsed - powered)
    const drag = 2.1
    const acceleration = 24 + salt * 35
    // Constant pressure acceleration with linear drag, followed by ballistic drag.
    const launchVelocity = acceleration / drag * (1 - Math.exp(-drag * powered))
    const distance = acceleration / drag * (powered - (1 - Math.exp(-drag * powered)) / drag) +
      launchVelocity * (1 - Math.exp(-drag * coast)) / drag
    const capture = smooth((t - (0.28 + salt * 0.035)) / (0.72 - salt * 0.035))
    const bx = sourceX + dx * distance
    const by = sourceY + dy * distance
    const bz = sourceZ + dz * distance
    out[0] = bx + (glyphX - bx) * capture
    out[1] = by + (glyphY - by) * capture
    out[2] = bz + (glyphZ - bz) * capture
    // Reveal sparse fragments as their projected area opens, then cool into the
    // original glyph coverage. A small, independently salted minority stays warm.
    const reveal = smooth(t / 0.18)
    const cooling = Math.exp(-Math.max(0, t - 0.18) * 5)
    const fragmentAlpha = sourceAlpha + (0.20 - sourceAlpha) * reveal * cooling
    out[3] = fragmentAlpha + (1 - fragmentAlpha) * capture
    out[4] = capture
    out[5] = salt > 0.93 ? reveal * cooling * (1 - capture) * 0.65 : 0
    return
  }

  const c = collapseProgress(t)
  const remain = 1 - c
  const cx = coreX - headX
  const cy = coreY - headY
  const cz = coreZ - headZ
  const coreRadius = Math.hypot(cx, cy, cz)
  const sourceAngle = Math.atan2(y, x)
  const coreAngle = Math.atan2(cy, cx)
  const angleDelta = Math.atan2(Math.sin(coreAngle - sourceAngle), Math.cos(coreAngle - sourceAngle))
  const sourceLatitude = Math.atan2(z, Math.hypot(x, y))
  const coreLatitude = Math.atan2(cz, Math.hypot(cx, cy))
  const spin = (2.2 + salt * 1.6) * t
  const angle = sourceAngle + angleDelta * c + spin * remain
  // Tilting the spiral changes depth without injecting radial energy. Radius is
  // strictly interpolated, so the inward motion cannot start with another burst.
  const latitude = sourceLatitude * remain + coreLatitude * c +
    Math.sin(sourceAngle + spin) * Math.sin(Math.PI * t) * 0.62 * remain
  const radius = sourceRadius + (coreRadius - sourceRadius) * c
  const planarRadius = radius * Math.cos(latitude)
  out[0] = headX + Math.cos(angle) * planarRadius
  out[1] = headY + Math.sin(angle) * planarRadius
  out[2] = headZ + Math.sin(latitude) * radius
  out[3] = coreAlpha + (sourceAlpha - coreAlpha) * remain * remain
  out[4] = remain
}
