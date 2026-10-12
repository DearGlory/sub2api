import type { ChoreographyOptions } from './types'
import type { SpaceDerivative, SpacePhase, SpacePoint, SpaceTimingOptions } from './spaceMotionContract'

/** Absolute camera travel since the animation clock's origin; never wraps. */
export function cameraTravelAt(_seconds: number): number {
  throw new Error('space motion implementation pending')
}

/** The world-Z offset of the glyph anchor reached at the end of this leg. */
export function glyphStopZ(_legIndex: number, _options: SpaceTimingOptions): number {
  throw new Error('space motion implementation pending')
}

/** Shared X/Z path. All outputs are relative to a fixed SUBJECT_Z group origin. */
export function sampleSpaceMotion(
  _legIndex: number, _phase: SpacePhase, _progress: number,
  _options: ChoreographyOptions, _out: SpacePoint, _derivative: SpaceDerivative = 0
): SpacePoint {
  throw new Error('space motion implementation pending')
}
