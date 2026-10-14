/**
 * Public surface of the particle home feature.
 *
 * FROZEN — owned by the integrator. `HomeView.vue` is the only consumer.
 */
export { ParticleEngine } from './engine'
export { BRANDS } from './engine'
export type {
  BrandDescriptor,
  CometPhase,
  EngineStats,
  ParticleEngineContract,
  ParticleEngineOptions,
  QualityProfile,
} from './engine'
export { default as HomeParticleBackground } from './HomeParticleBackground.vue'
