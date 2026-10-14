/**
 * Composition root for the particle home feature.
 *
 * FROZEN — owned by the integrator. Lanes import from here; they never edit it.
 */
export * from './types'
export * from './constants'
// LANE LC — the V6 sizing derivation. Exported so the mainline can ask "the camera
// sits here, how big must the glyph be?" instead of hard-coding a world size.
export * from './glyphSize'

export { createQualityProfile, probeQualityProfile } from './quality'
export { createChoreography } from './choreography'
export { createBrandTargetSource } from './brandTargets'
export { createStarfield } from './starfield'
export { ParticleEngine } from './ParticleEngine'
