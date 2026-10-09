/**
 * Composition root for the particle home feature.
 *
 * FROZEN — owned by the integrator. Lanes import from here; they never edit it.
 */
export * from './types'
export * from './constants'

export { createQualityProfile, probeQualityProfile } from './quality'
export { createChoreography } from './choreography'
export { createBrandTargetSource } from './brandTargets'
export { createStarfield } from './starfield'
export { ParticleEngine } from './ParticleEngine'
