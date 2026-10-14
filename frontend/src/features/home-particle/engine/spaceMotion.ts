import type { ChoreographyOptions } from './types'
import { GATHER_SECONDS, HOLD_SECONDS, LEG_SECONDS, SCATTER_SECONDS } from './constants'
import { COALESCE_END, departureSeconds } from './flightTiming'
import { sampleFlightPath } from './flightPath'
import { SPACE_CAMERA_SPEED } from './spaceMotionContract'
import type { SpaceDerivative, SpacePhase, SpacePoint, SpaceTimingOptions } from './spaceMotionContract'

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function safeLeg(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0
}

function cycleSeconds(options: SpaceTimingOptions): number {
  return positiveOr(options.legSeconds, LEG_SECONDS)
    + positiveOr(options.gatherSeconds, GATHER_SECONDS)
    + positiveOr(options.holdSeconds, HOLD_SECONDS)
    + positiveOr(options.scatterSeconds, SCATTER_SECONDS)
}

/** Absolute camera travel since the animation clock's origin; never wraps. */
export function cameraTravelAt(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? SPACE_CAMERA_SPEED * seconds : 0
}

/** The world-Z offset of the glyph anchor reached at the end of this leg. */
export function glyphStopZ(legIndex: number, options: SpaceTimingOptions): number {
  return SPACE_CAMERA_SPEED * (safeLeg(legIndex) * cycleSeconds(options)
    + positiveOr(options.legSeconds, LEG_SECONDS))
}

/** Shared X/Z path. All outputs are relative to a fixed SUBJECT_Z group origin. */
export function sampleSpaceMotion(
  legIndex: number, phase: SpacePhase, progress: number,
  options: ChoreographyOptions, out: SpacePoint, derivative: SpaceDerivative = 0
): SpacePoint {
  const leg = safeLeg(legIndex)
  const amplitudeX = Number.isFinite(options.amplitudeX) ? options.amplitudeX : 0
  const legSeconds = positiveOr(options.legSeconds, LEG_SECONDS)
  const scatterSeconds = positiveOr(options.scatterSeconds, SCATTER_SECONDS)
  const duration = legSeconds + scatterSeconds * (1 - COALESCE_END)
  const flightLeg = phase === 'scatter' ? leg + 1 : leg
  const stationary = phase === 'gather' || phase === 'hold'
  return sampleFlightPath(
    flightLeg,
    stationary ? duration : departureSeconds(phase, progress, legSeconds, scatterSeconds),
    duration, amplitudeX,
    glyphStopZ(flightLeg - 1, options), glyphStopZ(flightLeg, options),
    out, derivative
  )
}
