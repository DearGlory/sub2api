/**
 * LANE L2 — comet choreography. STUB: replaced by the lane.
 *
 * Pure, DOM-free phase clock: comet travels an S-curve, gathers into a glyph at
 * each extreme, holds it for HOLD_SECONDS, scatters, and repeats with the next
 * brand. See HOME-PARTICLE-DESIGN.md §1 (R3-R7) and §4.
 */
import type {
  Choreography,
  ChoreographyOptions,
  ChoreographyState,
} from './types'

export function createChoreography(
  options: ChoreographyOptions
): Choreography {
  const state: ChoreographyState = {
    phase: 'travel',
    phaseProgress: 0,
    legIndex: 0,
    brandIndex: 0,
    fromX: -options.amplitudeX,
    toX: options.amplitudeX,
    headX: -options.amplitudeX,
    headY: 0,
    headZ: 0,
  }

  return {
    update(_deltaSeconds: number): void {
      throw new Error('choreography: lane L2 has not implemented this yet')
    },
    get state(): ChoreographyState {
      return state
    },
    sampleTrail(
      _delaySeconds: number,
      out: { x: number; y: number; z: number }
    ): void {
      out.x = state.headX
      out.y = state.headY
      out.z = state.headZ
    },
    nextBrand(): void {
      throw new Error('choreography: lane L2 has not implemented this yet')
    },
  }
}
