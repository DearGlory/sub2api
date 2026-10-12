/** Internal, allocation-free X/Z flight and its shared departure clock. */
import type { SpaceDerivative, SpacePoint } from './spaceMotionContract'

export type FlightDerivative = SpaceDerivative

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

/**
 * One integrated speed envelope drives both axes: 420 ms launch, cruise, then
 * 120 ms capture. Smootherstep ramps give zero endpoint velocity/acceleration
 * and C2 joins. Short custom durations shorten the ramps to avoid overlap.
 * startZ/endZ are absolute offsets from the fixed subject group, including history.
 */
export function sampleFlightPath(
  legIndex: number,
  elapsed: number,
  duration: number,
  amplitudeX: number,
  startZ: number,
  endZ: number,
  out: SpacePoint,
  derivative: FlightDerivative
): SpacePoint {
  const launch = Math.min(0.42, duration * 0.1)
  const arrival = Math.min(0.12, duration * 0.3)
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
  const dir = ((leg % 2) + 2) % 2 === 0 ? 1 : -1
  const dx = 2 * amplitudeX * dir
  const dz = endZ - startZ
  out.y = 0
  if (derivative === 0) {
    out.x = amplitudeX * dir * (2 * u - 1)
    // Preserve the exact anchor at rest, including negative historical legs.
    out.z = u === 0 ? startZ : u === 1 ? endZ : startZ + dz * u
  } else if (derivative === 3) {
    // Orientation stays defined at zero speed; it does not imply motion at rest.
    const length = Math.hypot(dx, dz)
    out.x = length > 0 ? dx / length : 0
    out.z = length > 0 ? dz / length : 0
  } else {
    const rate = derivative === 1 ? speed : acceleration
    out.x = rate === 0 ? 0 : dx * rate
    out.z = rate === 0 ? 0 : dz * rate
  }
  return out
}
