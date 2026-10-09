/**
 * LANE L2 — quality ladder. STUB: replaced by the lane.
 *
 * Picks a quality profile from device hints so a weak GPU never gets 18000
 * particles. See HOME-PARTICLE-DESIGN.md §6.
 */
import type { QualityProfile } from './types'
import {
  ADAPTIVE_PARTICLE_COUNT,
  BASE_PARTICLE_COUNT,
  BASE_STAR_COUNT,
  LOW_DPR,
  MAX_DPR,
  MIN_PARTICLE_COUNT,
  VENDOR_ICON_CANVAS_SIZE,
} from './constants'

/** Build a profile from explicit knob values, filling the rest from the base. */
export function createQualityProfile(
  overrides: Partial<QualityProfile>
): QualityProfile {
  return {
    particleCount: BASE_PARTICLE_COUNT,
    maxDpr: MAX_DPR,
    antialias: false,
    starCount: BASE_STAR_COUNT,
    tailSampleCount: 96,
    iconCanvasSize: VENDOR_ICON_CANVAS_SIZE,
    ...overrides,
  }
}

/** Probe the running device and return the profile it can actually afford. */
export function probeQualityProfile(_viewWidth: number): QualityProfile {
  return createQualityProfile({
    particleCount: ADAPTIVE_PARTICLE_COUNT,
    maxDpr: LOW_DPR,
    starCount: MIN_PARTICLE_COUNT,
  })
}
