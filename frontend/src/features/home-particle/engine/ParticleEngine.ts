/**
 * LANE L1 — the render engine. STUB: replaced by the lane.
 *
 * Owns the three.js scene, the single `THREE.Points` draw call for the comet, the
 * camera dolly, the pointer field and the frame loop. Reads the choreography, the
 * starfield and the brand anchors; never touches the DOM beyond `container`.
 *
 * Performance rules that live here (HOME-PARTICLE-DESIGN.md §6):
 *   - one BufferGeometry, positions/colors updated in place, one draw call
 *   - zero per-frame allocation (everything preallocated on a scratch object)
 *   - `frameStep = min(dt * 60, 2)` so behaviour is framerate independent
 *   - rAF cancelled (not merely skipped) when hidden or scrolled out of view
 *   - `dispose()` releases geometry, material, texture, renderer and listeners
 */
import type {
  EngineStats,
  ParticleEngineContract,
  ParticleEngineOptions,
  QualityProfile,
} from './types'

export class ParticleEngine implements ParticleEngineContract {
  private readonly options: ParticleEngineOptions
  private readonly quality: Partial<QualityProfile> | undefined
  private running = false
  private light = false

  constructor(options: ParticleEngineOptions) {
    this.options = options
    this.quality = options.quality
    this.light = options.isLightTheme ?? false
  }

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  setTheme(isLightTheme: boolean): void {
    this.light = isLightTheme
  }

  /** The theme the next frame will be shaded for. */
  get isLightTheme(): boolean {
    return this.light
  }

  setReducedMotion(_value: boolean): void {
    /* lane L1 */
  }

  resize(): void {
    /* lane L1 */
  }

  /** The brand roster this engine cycles through. */
  get brands(): ParticleEngineOptions['brands'] {
    return this.options.brands
  }

  getStats(): EngineStats {
    return {
      fps: 0,
      particleCount: this.quality?.particleCount ?? 0,
      phase: 'travel',
      brandSlug: null,
      drawCalls: 0,
      triangles: 0,
      geometryBytes: 0,
    }
  }

  dispose(): void {
    this.running = false
  }

  /** Exposed for the integrator's smoke test; removed once the lane lands. */
  get isRunning(): boolean {
    return this.running
  }
}
