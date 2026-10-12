/** Internal, allocation-free spatial spline and its shared departure clock. */
import type { Point3 } from './choreography'

/** 0 = position, 1 = velocity, 2 = acceleration, 3 = unit forward tangent. */
export type FlightDerivative = 0 | 1 | 2 | 3

// Authored lobe locations, not noise. Full sway amplitudes are retained on every
// leg; only the spacing of the turns and the depth bow change slightly. Negative
// historical legs use the same periodic indexing as future ones.
const ARCS = [
  { crest: 0.24, trough: 0.73, bow: 0.08 },
  { crest: 0.27, trough: 0.75, bow: -0.06 },
  { crest: 0.25, trough: 0.77, bow: 0.04 },
  { crest: 0.23, trough: 0.74, bow: -0.09 },
  { crest: 0.26, trough: 0.72, bow: 0.06 },
  { crest: 0.25, trough: 0.75, bow: -0.03 },
] as const

/** Integral of smootherstep from 0 to q; at q=1 the area is exactly 1/2. */
function rampArea(q: number): number {
  return q * q * q * q * (2.5 + q * (q - 3))
}

function ramp(q: number): number {
  return q * q * q * (10 + q * (6 * q - 15))
}

function rampSlope(q: number): number {
  return 30 * q * q * (1 - q) * (1 - q)
}

/** Cubic Hermite, with slopes in units of the full path parameter (not local q). */
function cubic(
  q: number, width: number, start: number, end: number,
  startSlope: number, endSlope: number, derivative: 0 | 1 | 2
): number {
  const c = startSlope * width
  const d = endSlope * width
  const a = 2 * (start - end) + c + d
  const b = 3 * (end - start) - 2 * c - d
  if (derivative === 1) return (c + q * (2 * b + 3 * a * q)) / width
  if (derivative === 2) return (2 * b + 6 * a * q) / (width * width)
  return start + q * (c + q * (b + a * q))
}

/**
 * C2 cubic spline through (0,0), (crest,1), (trough,-1), (1,0).
 * The interior segment has zero slopes at both lobes. Matching its second
 * derivatives determines the endpoint slopes of the outer segments. Their
 * monotone Hermite controls keep |y| <= 1 without clipping or flattening a peak.
 */
function vertical(u: number, crest: number, trough: number, derivative: 0 | 1 | 2): number {
  const span = trough - crest
  if (u < crest) {
    const slope = 3 / crest - 6 * crest / (span * span)
    return cubic(u / crest, crest, 0, 1, slope, 0, derivative)
  }
  if (u < trough) {
    return cubic((u - crest) / span, span, 1, -1, 0, 0, derivative)
  }
  const width = 1 - trough
  const slope = 3 / width - 6 * width / (span * span)
  return cubic((u - trough) / width, width, -1, 0, 0, slope, derivative)
}

/** Smooth depth bow: a skewed quartic, not a second copy of the vertical lobe. */
function depth(u: number, skew: number, derivative: 0 | 1 | 2): number {
  const q = u + skew * u * (1 - u)
  const dq = 1 + skew * (1 - 2 * u)
  const slope = -32 * q * (1 - q) * (1 - 2 * q)
  if (derivative === 1) return slope * dq
  if (derivative === 2) {
    return -32 * (1 - 6 * q + 6 * q * q) * dq * dq - 2 * skew * slope
  }
  return -16 * q * q * (1 - q) * (1 - q)
}

/**
 * Position and actual time derivatives from ONE curve. The speed envelope has a
 * short 240 ms launch, a cruise, and a longer 1.8 s arrival. Integrating its two
 * smootherstep ramps gives exact distance and C2 (in fact C3) time joins. A single
 * global quintic over ~6.9 s would barely move during the entire scatter departure.
 * Short custom durations proportionally shorten the ramps so they cannot overlap.
 */
export function sampleFlightPath(
  legIndex: number,
  elapsed: number,
  duration: number,
  amplitudeX: number,
  swayY: number,
  swayZ: number,
  out: Point3,
  derivative: FlightDerivative
): Point3 {
  const launch = Math.min(0.24, duration * 0.1)
  const arrival = Math.min(1.8, duration * 0.3)
  const area = duration - (launch + arrival) / 2
  const t = Math.max(0, Math.min(duration, elapsed))
  let u: number
  let speed: number
  let acceleration: number
  if (t < launch) {
    const q = t / launch
    u = launch * rampArea(q) / area
    speed = ramp(q) / area
    acceleration = rampSlope(q) / (launch * area)
  } else if (t > duration - arrival) {
    // Evaluate backwards from arrival to avoid subtracting two large polynomials
    // near u=1. This also makes the final position/velocity/acceleration exact.
    const q = (duration - t) / arrival
    u = 1 - arrival * rampArea(q) / area
    speed = ramp(q) / area
    acceleration = -rampSlope(q) / (arrival * area)
  } else {
    u = (t - launch / 2) / area
    speed = 1 / area
    acceleration = 0
  }

  const leg = Number.isFinite(legIndex) ? Math.floor(legIndex) : 0
  const arc = ARCS[((leg % ARCS.length) + ARCS.length) % ARCS.length]
  const dir = ((leg % 2) + 2) % 2 === 0 ? 1 : -1
  const dx = 2 * amplitudeX * dir
  if (derivative === 0) {
    out.x = amplitudeX * dir * (2 * u - 1)
    // Canonical exact glyph anchors, with no signed-zero/residual spline error.
    out.y = u === 0 || u === 1 ? 0 : swayY * dir * vertical(u, arc.crest, arc.trough, 0)
    out.z = u === 0 || u === 1 ? 0 : swayZ * depth(u, arc.bow, 0)
    return out
  }

  const dy = swayY * dir * vertical(u, arc.crest, arc.trough, 1)
  const dz = swayZ * depth(u, arc.bow, 1)
  if (derivative === 3) {
    // The geometric tangent remains defined when the time derivative is zero.
    // A truly collapsed route has no direction; return zero, never invent an axis.
    const length = Math.hypot(dx, dy, dz)
    out.x = length > 0 ? dx / length : 0
    out.y = length > 0 ? dy / length : 0
    out.z = length > 0 ? dz / length : 0
  } else if (derivative === 1) {
    out.x = dx * speed
    out.y = dy * speed
    out.z = dz * speed
  } else {
    out.x = dx * acceleration
    out.y = swayY * dir * vertical(u, arc.crest, arc.trough, 2) * speed * speed + dy * acceleration
    out.z = swayZ * depth(u, arc.bow, 2) * speed * speed + dz * acceleration
  }
  return out
}
