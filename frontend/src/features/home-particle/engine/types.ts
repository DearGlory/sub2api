/**
 * Sub2API particle home — FROZEN CONTRACT.
 *
 * Every lane codes against this file. Do not edit it; if the contract is wrong,
 * report it to the integrator instead of changing it locally.
 *
 * See HOME-PARTICLE-DESIGN.md for the rules, the user's verbatim requirements and
 * the performance budget.
 */
import type { Object3D } from 'three'

// ---------------------------------------------------------------------------
// Choreography: comet -> glyph -> comet
// ---------------------------------------------------------------------------

/** `travel` is the comet cruising the S-curve, `gather`/`scatter` are the two
 *  transitions, `hold` is the 3 seconds the glyph is held while its particles
 *  keep flowing inside the shape. */
export type CometPhase = 'travel' | 'gather' | 'hold' | 'scatter'

export interface ChoreographyState {
  phase: CometPhase
  /** Progress through the current phase, 0..1. */
  phaseProgress: number
  /** Which S-leg of the current brand this is; parity flips travel direction. */
  legIndex: number
  /** Index into the brand list. */
  brandIndex: number
  /** Extreme the current leg started from, and the one it is heading to. */
  fromX: number
  toX: number
  /** Comet head in subject space (x right, y up, z toward the camera). */
  headX: number
  headY: number
  headZ: number
}

export interface ChoreographyOptions {
  /** Number of brands to cycle through. Comes from the engine's brand list, so a
   *  caller that passes a short roster still wraps correctly instead of stepping
   *  past the end of it. */
  brandCount: number
  amplitudeX: number
  swayY: number
  swayZ: number
  legSeconds: number
  gatherSeconds: number
  holdSeconds: number
  scatterSeconds: number
}

/**
 * Pure, DOM-free phase clock. `sampleTrail()` replays the head's own path
 * analytically so a trail particle needs no history buffer.
 */
export interface Choreography {
  update(deltaSeconds: number): void
  readonly state: ChoreographyState
  /** Head position `delaySeconds` in the past, written into `out`. */
  sampleTrail(
    delaySeconds: number,
    out: { x: number; y: number; z: number }
  ): void
  /** Advance to the next brand without waiting out the current leg. */
  nextBrand(): void
  /**
   * Retune the vertical sway, for a viewport whose aspect changes how steeply the
   * plume reads on screen.
   *
   * Only `swayY` is exposed: it is the one term that aims the plume along the screen's
   * vertical, which is where the long axis is on a portrait viewport. Retuning
   * `amplitudeX` or `swayZ` at runtime would move the glyph or tilt the axis into
   * depth, and neither is a function of the viewport.
   *
   * The value is sanitised the same way the constructor's is, so a caller that resizes
   * into a degenerate aspect cannot write a NaN into `state.headY`.
   */
  setSwayY(next: number): void
}

// ---------------------------------------------------------------------------
// Brand glyph targets
// ---------------------------------------------------------------------------

export interface BrandDescriptor {
  /** File stem under `assets/brands/<slug>.svg`. */
  slug: string
  /** Human label, used for the aria label and debug readout. */
  label: string
  /** Optional hue applied while the glyph is held, as a hex string. */
  accent?: string
}

export interface BrandTargets {
  /** Anchor positions in glyph local space, length `count * 3`. */
  targets: Float32Array
  /** Distance from each anchor to the nearest stroke edge, in world units. */
  strokeDepth: Float32Array
  /** Distinct anchors sampled from the mask, for diagnostics. */
  anchorCount: number
}

/**
 * Rasterises the official brand SVGs into particle anchors. Work is lazy: a slug
 * the source has not been asked to `prefetch`/`ensure` yet returns `null` from
 * `get()` rather than blocking the frame on a decode.
 */
export interface BrandTargetSource {
  get(slug: string): BrandTargets | null
  /**
   * Kick off the work off the critical path (requestIdleCallback when present).
   * `canvasSize` is the quality profile's `iconCanvasSize`: a weaker device
   * rasterises the glyph smaller and spends proportionally less CPU per brand.
   */
  prefetch(slug: string, count: number, canvasSize?: number): void
  /** Synchronously produce the targets, or `null` if the glyph cannot be read. */
  ensure(slug: string, count: number, canvasSize?: number): BrandTargets | null
  dispose(): void
}

// ---------------------------------------------------------------------------
// Starfield
// ---------------------------------------------------------------------------

export interface StarfieldOptions {
  count?: number
  reducedMotion?: boolean
  isLightTheme?: boolean
}

export interface Starfield {
  readonly object: Object3D
  /** `cameraZ` lets the field recycle stars as the camera dollies past them. */
  update(deltaSeconds: number, cameraZ: number, time: number): void
  setTheme(isLightTheme: boolean): void
  setReducedMotion(value: boolean): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface QualityProfile {
  particleCount: number
  maxDpr: number
  antialias: boolean
  starCount: number
  /** Samples per trail particle set, i.e. how finely the tail is shaped. */
  tailSampleCount: number
  iconCanvasSize: number
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EngineStats {
  fps: number
  particleCount: number
  phase: CometPhase
  brandSlug: string | null
  drawCalls: number
  triangles: number
  geometryBytes: number
}

export interface ParticleEngineOptions {
  container: HTMLElement
  brands: BrandDescriptor[]
  isLightTheme?: boolean
  reducedMotion?: boolean
  quality?: Partial<QualityProfile>
  targetSource?: BrandTargetSource
  onBrandChange?: (slug: string, index: number) => void
  onPhaseChange?: (phase: CometPhase) => void
  onError?: (error: unknown) => void
}

export interface ParticleEngineContract {
  start(): void
  stop(): void
  setTheme(isLightTheme: boolean): void
  setReducedMotion(value: boolean): void
  resize(): void
  getStats(): EngineStats
  dispose(): void
}
