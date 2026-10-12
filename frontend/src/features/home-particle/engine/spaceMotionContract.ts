import type { ChoreographyOptions, CometPhase } from './types'

/** Camera retreats along world +Z; the comet shares one X/Z progress clock. */
export const SPACE_CAMERA_SPEED = 1.35
export const SPACE_CAPTURE_TOLERANCE = 0.08

export type SpaceTimingOptions = Pick<ChoreographyOptions,
  'legSeconds' | 'gatherSeconds' | 'holdSeconds' | 'scatterSeconds'>

export interface SpacePoint {
  x: number
  y: number
  z: number
}

/** Position, velocity, acceleration or unit forward tangent. */
export type SpaceDerivative = 0 | 1 | 2 | 3
export type SpacePhase = CometPhase
