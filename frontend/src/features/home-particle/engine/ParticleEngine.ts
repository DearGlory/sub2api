/**
 * LANE L1 — the render engine.
 *
 * Ports GloryCode's React/R3F particle render loop to a framework-agnostic
 * three.js class. The R3F shell is gone; the math is not — every per-particle
 * rule (bounded orbit flow while holding, pointer push, hold spring, hold pose)
 * comes from `vendor/voxspace-math.ts`, the same code the reference drives.
 *
 * What the reference does NOT have, and what this file adds, is the choreography
 * the user asked for: a comet with a tail sweeping an S-curve, gathering into a
 * brand glyph at each extreme, holding that glyph for three seconds while the
 * particles keep flowing inside the shape, then scattering back into a comet —
 * under a camera that keeps pulling back through a deep starfield.
 *
 * Performance rules that live here (HOME-PARTICLE-DESIGN.md §6):
 *   - one BufferGeometry, positions/colors updated in place, one draw call
 *   - zero per-frame allocation: every buffer is preallocated in `scratch`, and
 *     `sampleTrail` is evaluated `tailSampleCount` times per frame into a lookup
 *     table the particles index — not once per particle
 *   - `frameStep = min(dt * 60, 2)` so behaviour is framerate independent
 *   - `stop()` cancels the rAF, it does not merely skip the render
 *   - `dispose()` releases geometry, material, texture, renderer and every listener
 *
 * Without a WebGL context (jsdom, an old browser, a driver that refuses) the
 * constructor throws and the caller shows its flat fallback. That is deliberate:
 * a half-built engine that silently renders nothing is worse than an error the
 * shell can react to.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  NormalBlending,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'

import {
  applyVoxSpacePointerPush,
  clamp01,
  createInitialScatterTargets,
  createVoxSpaceIconOrbitField,
  fillVoxSpaceIconOrbitField,
  fillVoxSpaceIconOrbitOffsets,
  getVoxSpaceHoldFrameFriction,
  isVoxSpacePointerActive,
  nextVoxSpaceIconHoldFade,
  smootherStep,
  stepVoxSpaceHoldParticle,
  writeVoxSpaceIconHoldPose,
  type VoxSpaceIconHoldPose,
  type VoxSpaceIconOrbitField,
  type VoxSpacePointerField,
} from '../vendor/voxspace-math'

import { createBrandTargetSource } from './brandTargets'
import { createChoreography } from './choreography'
import {
  AMPLITUDE_X,
  BRANDS,
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  DOLLY_FROM_Z,
  DOLLY_PERIOD_SECONDS,
  DOLLY_TO_Z,
  DOLLY_WRAP_SECONDS,
  FRICTION,
  GATHER_SECONDS,
  HEAD_CORE_SHARE,
  HOLD_SECONDS,
  LEG_SECONDS,
  POINTER_RADIUS,
  SCATTER_SECONDS,
  SUBJECT_Z,
  SWAY_Y,
  SWAY_Z,
  TAIL_RADIUS,
  TAIL_SECONDS,
  TAIL_SPREAD,
} from './constants'
import { createQualityProfile, probeQualityProfile } from './quality'
import { createStarfield } from './starfield'
import type {
  BrandTargetSource,
  Choreography,
  CometPhase,
  EngineStats,
  ParticleEngineContract,
  ParticleEngineOptions,
  QualityProfile,
  Starfield,
} from './types'

/** Where the vendor's glyph sampler centres a glyph, in its own units. */
const GLYPH_CENTER_X = 5.8
/** Half extent of the sampler's glyph box, in world units. */
const GLYPH_HALF_EXTENT = 6.3
/** Breathing room so the framed content never sits flush against the edge. */
const FRAME_MARGIN = 1.12
/** Cap on the per-frame step fed to the phase clock, in seconds. A tab that was
 *  asleep must not skip a whole beat: running briefly slow beats jumping. */
const MAX_CLOCK_STEP = 0.1
/** Velocity memory for the comet phases, matching the vendored hold spring. */
const COMET_VELOCITY_MEMORY = 0.26
/** Spring stiffness per phase. The hold is stiffest, which is what makes a formed
 *  glyph read as solid rather than as a cloud passing through it. */
const FOLLOW_TRAVEL = 0.055
const FOLLOW_GATHER = 0.1
const FOLLOW_HOLD = 0.105
const FOLLOW_SCATTER = 0.085

// ---------------------------------------------------------------------------
// Glow sprite — one per process, refcounted
// ---------------------------------------------------------------------------

let sharedGlow: CanvasTexture | null = null
let glowRefs = 0

/**
 * Soft radial sprite for every particle. Shared because a per-engine copy would be
 * identical bytes and a second GPU upload; refcounted because an HMR remount must
 * not dispose the texture a still-running engine points at.
 */
function acquireGlowTexture(): CanvasTexture | null {
  if (sharedGlow) {
    glowRefs += 1
    return sharedGlow
  }

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.16, 'rgba(255,255,255,.98)')
  gradient.addColorStop(0.42, 'rgba(255,255,255,.58)')
  gradient.addColorStop(0.72, 'rgba(255,255,255,.20)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)

  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  sharedGlow = texture
  glowRefs += 1
  return texture
}

function releaseGlowTexture(): void {
  glowRefs = Math.max(0, glowRefs - 1)
  if (glowRefs === 0 && sharedGlow) {
    sharedGlow.dispose()
    sharedGlow = null
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

interface ThemePalette {
  core: Color
  accent: Color
  gain: number
  blending: typeof AdditiveBlending | typeof NormalBlending
  background: Color
  opacity: number
  pointSize: number
}

function paletteFor(isLightTheme: boolean): ThemePalette {
  return isLightTheme
    ? {
        // Additive blending washes out to white on a pale page, so the light theme
        // is dark ink on a bright sky and must blend normally.
        core: new Color(0.16, 0.19, 0.26),
        accent: new Color(0.85, 0.33, 0.01),
        gain: 0.6,
        blending: NormalBlending,
        background: new Color(0.976, 0.98, 0.984),
        opacity: 0.8,
        pointSize: 0.082,
      }
    : {
        // Deep space: cool-white stardust with the site's single warm accent used
        // only at the head. A saturated head would fight the glyph it forms.
        core: new Color(0.88, 0.92, 1.0),
        accent: new Color(1.0, 0.42, 0.05),
        gain: 1.22,
        blending: AdditiveBlending,
        background: new Color(0.012, 0.016, 0.039),
        opacity: 1.0,
        pointSize: 0.098,
      }
}

// ---------------------------------------------------------------------------
// Scratch — allocated once per engine, mutated in place
// ---------------------------------------------------------------------------

interface EngineScratch {
  positions: Float32Array
  velocities: Float32Array
  colors: Float32Array
  /** Where each particle sits along the tail: 0 head, 1 tip. */
  tailT: Float32Array
  /** Stable angle around the tail axis, so a particle cannot jump slots. */
  tailAngle: Float32Array
  /** Stable thickness multiplier — without it the tail is a smooth cone. */
  tailRadius: Float32Array
  /** Stable swirl rate, so the tail does not rotate as one rigid body. */
  tailSpin: Float32Array
  /** Stable per-particle phase for the shimmer term. */
  tailSeed: Float32Array
  /** Glyph anchors in subject space for the brand being assembled. */
  glyphTargets: Float32Array
  glyphStrokeDepth: Float32Array
  /** Per-frame tail path lookup table, `tailSampleCount * 3`. */
  tailLut: Float32Array
  /** Per-frame radial drift of the internal glyph flow. */
  iconOrbitOffsets: Float32Array
  iconOrbitField: VoxSpaceIconOrbitField
  iconHoldPose: VoxSpaceIconHoldPose
  pointerField: VoxSpacePointerField
  /** Reused vectors — the frame loop must not construct any. */
  vecA: Vector3
  vecB: Vector3
  inverseRotation: Quaternion
}

export function createEngineScratch(count: number, tailSampleCount: number): EngineScratch {
  // Golden-ratio spacing gives low-discrepancy coverage of [0,1] for any count,
  // which is what keeps the tail from banding. Raising t to a power packs more of
  // the cloud near the head, where a comet is densest.
  const tailT = new Float32Array(count)
  const tailAngle = new Float32Array(count)
  const tailRadius = new Float32Array(count)
  const tailSpin = new Float32Array(count)
  const tailSeed = new Float32Array(count)
  const golden = 0.6180339887498949
  const coreCount = Math.floor(count * HEAD_CORE_SHARE)

  for (let i = 0; i < count; i++) {
    const u = (i * golden + 0.5) % 1
    tailT[i] = i < coreCount ? 0 : Math.pow(u, 1.35)
    tailAngle[i] = ((i * golden * 7.0) % 1) * Math.PI * 2
    tailRadius[i] = 0.62 + ((i * golden * 3.0) % 1) * 0.78
    tailSpin[i] = 0.55 + ((i * golden * 11.0) % 1) * 0.9
    tailSeed[i] = (i * golden * 17.0) % 1
  }

  return {
    // The opening frame is a wide scatter that the spring pulls into the first
    // comet, so the background assembles itself instead of popping into being.
    positions: createInitialScatterTargets(count),
    velocities: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    tailT,
    tailAngle,
    tailRadius,
    tailSpin,
    tailSeed,
    glyphTargets: new Float32Array(count * 3),
    glyphStrokeDepth: new Float32Array(count),
    tailLut: new Float32Array(tailSampleCount * 3),
    iconOrbitOffsets: new Float32Array(count * 3),
    iconOrbitField: createVoxSpaceIconOrbitField(count),
    iconHoldPose: { rotationX: 0, rotationY: 0, rotationZ: 0, toneScale: 0 },
    pointerField: {
      localX: 0,
      localY: 0,
      localZ: 0,
      radius: POINTER_RADIUS,
      radiusSq: POINTER_RADIUS * POINTER_RADIUS,
      time: 0,
    },
    vecA: new Vector3(),
    vecB: new Vector3(),
    inverseRotation: new Quaternion(),
  }
}

/** The blend weight between the comet shape and the glyph shape, for a phase. */
export function glyphMixFor(phase: CometPhase, progress: number): number {
  switch (phase) {
    case 'travel':
      return 0
    case 'gather':
      return smootherStep(clamp01(progress))
    case 'hold':
      return 1
    default:
      return 1 - smootherStep(clamp01(progress))
  }
}

/** Spring stiffness for a phase. Exported so the tests can pin the ordering that
 *  makes a held glyph read as solid: hold > gather > scatter > travel. */
export function followSpeedFor(phase: CometPhase): number {
  switch (phase) {
    case 'hold':
      return FOLLOW_HOLD
    case 'gather':
      return FOLLOW_GATHER
    case 'scatter':
      return FOLLOW_SCATTER
    default:
      return FOLLOW_TRAVEL
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ParticleEngine implements ParticleEngineContract {
  private readonly options: ParticleEngineOptions
  private readonly quality: QualityProfile
  private readonly roster: readonly { slug: string; label: string }[]

  private readonly container: HTMLElement
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera: PerspectiveCamera
  private readonly points: Points
  private readonly geometry: BufferGeometry
  private readonly material: PointsMaterial

  private readonly choreography: Choreography
  private readonly starfield: Starfield
  private readonly brandSource: BrandTargetSource
  private readonly ownsBrandSource: boolean

  private readonly scratch: EngineScratch
  /** One object, mutated in place and republished every frame (see §6 item 2). */
  private readonly stats: EngineStats

  private running = false
  private rafId = 0
  private disposed = false
  private lastFrameMs = 0
  private dollySeconds = 0
  private reducedMotion: boolean
  private light: boolean
  private palette: ThemePalette
  private width = 1
  private height = 1
  private fitDistance = DOLLY_FROM_Z
  private readonly particleCount: number
  private readonly tailSampleCount: number
  private readonly frameTimes = new Float64Array(30)
  private frameCount = 0
  private frameCursor = 0

  private readonly pointer = { clientX: 0, clientY: 0, active: false, lastMove: 0 }
  private pointerBound = false

  private currentBrandSlug: string | null = null
  private lastPhase: CometPhase = 'travel'
  private holdFade = 0

  constructor(options: ParticleEngineOptions) {
    this.options = options
    this.container = options.container
    this.light = options.isLightTheme ?? false
    this.reducedMotion = options.reducedMotion ?? false
    this.palette = paletteFor(this.light)
    this.roster = options.brands.length > 0 ? options.brands : BRANDS

    const probed = probeQualityProfile(
      typeof window === 'undefined' ? 1280 : window.innerWidth
    )
    this.quality = createQualityProfile({ ...probed, ...options.quality })
    this.particleCount = Math.max(1, Math.floor(this.quality.particleCount))
    this.tailSampleCount = Math.max(8, Math.floor(this.quality.tailSampleCount))

    const rect = this.container.getBoundingClientRect()
    this.width = Math.max(1, Math.floor(rect.width || this.container.clientWidth || 1))
    this.height = Math.max(1, Math.floor(rect.height || this.container.clientHeight || 1))

    // Throws when there is no context to be had; the caller degrades.
    this.renderer = new WebGLRenderer({
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr))
    this.renderer.setSize(this.width, this.height, true)
    this.renderer.setClearColor(this.palette.background, this.light ? 1 : 0)

    const canvas = this.renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.setAttribute('aria-hidden', 'true')
    this.container.appendChild(canvas)

    this.camera = new PerspectiveCamera(
      CAMERA_FOV,
      this.width / this.height,
      CAMERA_NEAR,
      CAMERA_FAR
    )
    this.camera.position.set(0, 0, DOLLY_FROM_Z)

    this.scratch = createEngineScratch(this.particleCount, this.tailSampleCount)

    this.geometry = new BufferGeometry()
    const posAttr = new BufferAttribute(this.scratch.positions, 3)
    posAttr.setUsage(DynamicDrawUsage)
    const colAttr = new BufferAttribute(this.scratch.colors, 3)
    colAttr.setUsage(DynamicDrawUsage)
    this.geometry.setAttribute('position', posAttr)
    this.geometry.setAttribute('color', colAttr)
    // The cloud is authored per frame and never culled, so three must not try to
    // compute a bounding sphere from one frame's worth of positions.
    this.geometry.boundingSphere = null

    this.material = new PointsMaterial({
      map: acquireGlowTexture() ?? undefined,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: this.palette.blending,
      size: this.palette.pointSize,
      sizeAttenuation: true,
      opacity: this.palette.opacity,
    })

    this.points = new Points(this.geometry, this.material)
    // The slab is moved, not the camera, so the pointer ray and the glyph anchors
    // share one frame of reference.
    this.points.position.set(0, 0, SUBJECT_Z)
    this.points.frustumCulled = false
    this.scene.add(this.points)

    this.starfield = createStarfield({
      count: this.quality.starCount,
      reducedMotion: this.reducedMotion,
      isLightTheme: this.light,
    })
    this.scene.add(this.starfield.object)

    this.choreography = createChoreography({
      brandCount: this.roster.length,
      amplitudeX: AMPLITUDE_X,
      swayY: SWAY_Y,
      swayZ: SWAY_Z,
      legSeconds: LEG_SECONDS,
      gatherSeconds: GATHER_SECONDS,
      holdSeconds: HOLD_SECONDS,
      scatterSeconds: SCATTER_SECONDS,
    })

    this.ownsBrandSource = !options.targetSource
    this.brandSource = options.targetSource ?? createBrandTargetSource()

    this.stats = {
      fps: 0,
      particleCount: this.particleCount,
      phase: 'travel',
      brandSlug: null,
      drawCalls: 0,
      triangles: 0,
      geometryBytes: 0,
    }

    this.updateCameraFit()
    this.bindPointer()
    this.bindContextLoss()

    // Seed the opening glyph and queue the next, so the first gather never waits
    // on a rasterise.
    this.syncGlyph()
    this.prefetchAhead()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.lastFrameMs = 0
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId) {
      // Cancelling — rather than returning early inside the callback — is what
      // makes a hidden tab cost nothing instead of a no-op frame every tick.
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  setTheme(isLightTheme: boolean): void {
    if (this.disposed || this.light === isLightTheme) return
    this.light = isLightTheme
    this.palette = paletteFor(isLightTheme)
    this.material.blending = this.palette.blending
    this.material.size = this.palette.pointSize
    this.material.opacity = this.palette.opacity
    this.material.needsUpdate = true
    this.renderer.setClearColor(this.palette.background, isLightTheme ? 1 : 0)
    this.starfield.setTheme(isLightTheme)
    // Colours are rewritten every frame, so the next tick picks the palette up.
  }

  setReducedMotion(value: boolean): void {
    if (this.disposed || this.reducedMotion === value) return
    this.reducedMotion = value
    this.starfield.setReducedMotion(value)
    // The dolly is the loudest motion here, so a reduced-motion visitor gets a
    // fixed camera rather than a snap mid-sweep.
    if (value) this.dollySeconds = 0
    this.updateCameraFit()
  }

  resize(): void {
    if (this.disposed) return
    const rect = this.container.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width || this.container.clientWidth || 1))
    const h = Math.max(1, Math.floor(rect.height || this.container.clientHeight || 1))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr))
    this.renderer.setSize(w, h, true)
    this.updateCameraFit()
  }

  getStats(): EngineStats {
    return this.stats
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.unbindPointer()
    this.unbindContextLoss()

    this.scene.remove(this.points)
    this.scene.remove(this.starfield.object)
    this.starfield.dispose()

    this.geometry.dispose()
    this.material.dispose()
    releaseGlowTexture()

    if (this.ownsBrandSource) this.brandSource.dispose()

    const canvas = this.renderer.domElement
    canvas.parentNode?.removeChild(canvas)
    this.renderer.dispose()
    // The only way to hand the GPU budget back: without this a route change leaves
    // the context alive until the browser evicts it, and browsers cap contexts.
    this.renderer.forceContextLoss()

    if (typeof window !== 'undefined') {
      const holder = window as unknown as Record<string, unknown>
      if (holder.__SUB2API_PARTICLE_STATS__ === this.stats) {
        holder.__SUB2API_PARTICLE_STATS__ = null
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    if (this.pointerBound) return
    // The canvas is pointer-events-none so the background never eats a click meant
    // for the page, so the listeners have to sit on the window.
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerleave', this.onPointerLeave)
    this.pointerBound = true
  }

  private unbindPointer(): void {
    if (!this.pointerBound) return
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerleave', this.onPointerLeave)
    this.pointerBound = false
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    // Only the raw position is recorded here: a burst of pointer events allocates
    // nothing and cannot outpace the frame that consumes the result.
    this.pointer.clientX = event.clientX
    this.pointer.clientY = event.clientY
    this.pointer.active = true
    this.pointer.lastMove = performance.now()
  }

  private readonly onPointerLeave = (): void => {
    this.pointer.active = false
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the context never comes back and the canvas stays
    // blank for the life of the page.
    event.preventDefault()
    this.stop()
    this.options.onError?.(new Error('ParticleEngine: WebGL context lost'))
  }

  private bindContextLoss(): void {
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false)
  }

  private unbindContextLoss(): void {
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost, false)
  }

  /**
   * Pull the camera back far enough that the widest content — a glyph sitting on
   * the left or right extreme — still fits at this aspect ratio, and never let the
   * dolly come nearer than that. A fixed camera distance clips the glyph on
   * portrait, which is exactly the case a phone would hit.
   */
  private updateCameraFit(): void {
    const aspect = Math.max(0.2, this.width / this.height)
    const tan = Math.tan((CAMERA_FOV * Math.PI) / 360)
    const needWidth = (AMPLITUDE_X + GLYPH_HALF_EXTENT) * FRAME_MARGIN
    const needHeight = GLYPH_HALF_EXTENT * FRAME_MARGIN
    const forWidth = needWidth / (tan * aspect)
    const forHeight = needHeight / tan
    this.fitDistance = Math.max(forWidth, forHeight) + Math.abs(SUBJECT_Z)
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private readonly tick = (): void => {
    if (!this.running || this.disposed) return
    this.rafId = requestAnimationFrame(this.tick)

    const now = performance.now()
    const delta = this.lastFrameMs === 0 ? 1 / 60 : (now - this.lastFrameMs) / 1000
    this.lastFrameMs = now

    // Frame-rate independence: per-particle physics is expressed per 60 Hz frame,
    // and the step is clamped so a stall cannot fling the cloud across the scene.
    const frameStep = Math.min(Math.max(delta * 60, 0.0001), 2)
    const clockStep = Math.min(Math.max(delta, 0), MAX_CLOCK_STEP)

    try {
      this.advanceClock(clockStep)
      this.writeTailLut()
      this.integrate(frameStep, now / 1000)
      this.upload()
      this.advanceCamera()
      this.starfield.update(clockStep, this.camera.position.z, now / 1000)
      this.renderer.render(this.scene, this.camera)
      this.publishStats(now)
    } catch (error) {
      // A throw inside a rAF callback would otherwise repeat every frame forever.
      this.stop()
      this.options.onError?.(error)
    }
  }

  private advanceClock(delta: number): void {
    this.choreography.update(delta)
    const state = this.choreography.state

    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase
      this.options.onPhaseChange?.(state.phase)
    }

    const brand = this.roster[state.brandIndex % this.roster.length]
    if (brand && brand.slug !== this.currentBrandSlug) {
      this.currentBrandSlug = brand.slug
      this.syncGlyph()
      this.options.onBrandChange?.(brand.slug, state.brandIndex)
    }
    this.prefetchAhead()

    if (!this.reducedMotion) this.dollySeconds += delta
  }

  /** Queue the glyph after the current one, off the critical path. */
  private prefetchAhead(): void {
    const state = this.choreography.state
    const next = this.roster[(state.brandIndex + 1) % this.roster.length]
    if (next) {
      this.brandSource.prefetch(next.slug, this.particleCount, this.quality.iconCanvasSize)
    }
  }

  /**
   * Load the glyph for the current brand into scratch and bake its orbit field.
   *
   * The sampler works in its own glyph space, centred on `GLYPH_CENTER_X`; the
   * engine works in subject space, centred on the extreme the comet arrived at.
   * The shift happens here so every later stage (spring, orbit flow, colouring)
   * sees a single frame of reference.
   */
  private syncGlyph(): void {
    const brand = this.roster[this.choreography.state.brandIndex % this.roster.length]
    if (!brand) return

    const targets = this.brandSource.ensure(
      brand.slug,
      this.particleCount,
      this.quality.iconCanvasSize
    )
    if (!targets) return

    // The glyph is drawn around whichever extreme the current leg ends on, so a
    // brand switch mid-sweep still lands the shape where the comet arrived.
    const amplitude = this.choreography.state.toX
    const glyph = this.scratch.glyphTargets
    const n = Math.min(this.particleCount, Math.floor(targets.targets.length / 3))
    for (let i = 0; i < n; i++) {
      glyph[i * 3] = targets.targets[i * 3] - GLYPH_CENTER_X + amplitude
      glyph[i * 3 + 1] = targets.targets[i * 3 + 1]
      glyph[i * 3 + 2] = targets.targets[i * 3 + 2]
    }
    // Particles beyond the glyph's anchor count have nowhere to sit; parking them
    // on the glyph's centre point keeps them inside the shape instead of leaving a
    // visible clump where the last anchor ended.
    for (let i = n; i < this.particleCount; i++) {
      glyph[i * 3] = amplitude
      glyph[i * 3 + 1] = 0
      glyph[i * 3 + 2] = 0
    }
    this.scratch.glyphStrokeDepth.set(targets.strokeDepth.subarray(0, n))

    fillVoxSpaceIconOrbitField(
      this.scratch.iconOrbitField,
      targets.targets,
      targets.strokeDepth
    )
  }

  /**
   * Evaluate the comet's past path into a lookup table once per frame. This is the
   * difference between ~100 and ~18000 calls to `sampleTrail` per frame, and it is
   * what gives `tailSampleCount` a job.
   */
  private writeTailLut(): void {
    const lut = this.scratch.tailLut
    const n = this.tailSampleCount
    const out = this.scratch.vecB
    const step = TAIL_SECONDS / Math.max(1, n - 1)
    for (let s = 0; s < n; s++) {
      this.choreography.sampleTrail(s * step, out)
      lut[s * 3] = out.x
      lut[s * 3 + 1] = out.y
      lut[s * 3 + 2] = out.z
    }
  }

  private integrate(frameStep: number, time: number): void {
    const s = this.scratch
    const positions = s.positions
    const velocities = s.velocities
    const colors = s.colors
    const glyph = s.glyphTargets
    const lut = s.tailLut
    const count = this.particleCount
    const state = this.choreography.state
    const palette = this.palette
    const phase = state.phase

    // How committed this frame is to the glyph shape: 0 is a pure comet, 1 is the
    // settled logo. Everything that only makes sense on a glyph is gated by it, so
    // the two shapes can never bleed into each other.
    let glyphMix = glyphMixFor(phase, state.phaseProgress)
    // Reduced motion snaps the blend instead of animating it: the shape change is
    // the part of this that a motion-sensitive visitor asked us not to animate.
    if (this.reducedMotion) glyphMix = glyphMix > 0.5 ? 1 : 0

    // The internal flow the user asked for: the glyph holds its outline while the
    // particles inside it keep drifting. Gated by the same mix, so it fades in and
    // out with the shape instead of switching on.
    if (glyphMix > 0.001) {
      fillVoxSpaceIconOrbitOffsets(s.iconOrbitOffsets, s.iconOrbitField, time, glyphMix)
    }

    const followSpeed = this.reducedMotion ? FOLLOW_TRAVEL * 0.6 : followSpeedFor(phase)
    const friction =
      phase === 'hold'
        ? getVoxSpaceHoldFrameFriction(frameStep)
        : Math.pow(FRICTION, frameStep)

    // Hold pose: a slow tilt plus a front-to-back tone split, which is what gives
    // the flat slab volume. Faded, so a brand switch cannot drop it in one frame.
    this.holdFade = nextVoxSpaceIconHoldFade(this.holdFade, glyphMix, frameStep)
    writeVoxSpaceIconHoldPose(s.iconHoldPose, time, this.holdFade)
    this.points.rotation.z = s.iconHoldPose.rotationZ
    this.points.rotation.x = s.iconHoldPose.rotationX
    this.points.rotation.y = s.iconHoldPose.rotationY

    // Pointer, resolved into the object's own frame so the repulsion stays under
    // the cursor even while the slab is tilted.
    let pointerActive = isVoxSpacePointerActive(
      this.pointer.active,
      this.pointer.lastMove,
      performance.now()
    )
    if (pointerActive) {
      const rect = this.renderer.domElement.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const ndc = s.vecA.set(
          ((this.pointer.clientX - rect.left) / rect.width) * 2 - 1,
          -(((this.pointer.clientY - rect.top) / rect.height) * 2 - 1),
          0.5
        )
        ndc.unproject(this.camera)
        const dir = s.vecB.copy(ndc).sub(this.camera.position)
        const dirZ = dir.z
        dir.normalize()
        // Intersect the view ray with the slab's own plane.
        const distance = dirZ === 0 ? -1 : (SUBJECT_Z - this.camera.position.z) / dir.z
        if (Number.isFinite(distance) && distance > 0) {
          const world = s.vecA
            .copy(this.camera.position)
            .addScaledVector(dir, distance)
            .sub(this.points.position)
          s.inverseRotation.copy(this.points.quaternion).invert()
          world.applyQuaternion(s.inverseRotation)
          s.pointerField.localX = world.x
          s.pointerField.localY = world.y
          s.pointerField.localZ = world.z
          s.pointerField.time = time
        } else {
          pointerActive = false
        }
      } else {
        pointerActive = false
      }
    }

    const lutMax = this.tailSampleCount - 1
    const coreCount = count * HEAD_CORE_SHARE
    const spin = this.reducedMotion ? 0 : 1
    const useHoldStep = phase === 'hold' && glyphMix > 0.5

    for (let i = 0; i < count; i++) {
      const idx = i * 3
      const px = positions[idx]
      const py = positions[idx + 1]
      const pz = positions[idx + 2]

      // --- comet target: a point on the path, thickened into a cone ----------
      const t = s.tailT[i]
      const scaled = t * lutMax
      const k = Math.floor(scaled)
      const k1 = k + 1 > lutMax ? lutMax : k + 1
      const frac = scaled - k
      const ax = lut[k * 3]
      const ay = lut[k * 3 + 1]
      const az = lut[k * 3 + 2]
      const bx = lut[k1 * 3]
      const by = lut[k1 * 3 + 1]
      const bz = lut[k1 * 3 + 2]

      // Radius grows down the tail, which is what makes the head a bright core and
      // the tip a diffuse plume.
      const delay = t * TAIL_SECONDS
      const radius =
        (TAIL_RADIUS + TAIL_SPREAD * delay * s.tailRadius[i]) * (i < coreCount ? 0.34 : 1)
      const angle = s.tailAngle[i] + time * s.tailSpin[i] * spin
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)

      const cometX = ax + (bx - ax) * frac + sinA * radius * 0.35
      const cometY = ay + (by - ay) * frac + cosA * radius
      const cometZ = az + (bz - az) * frac + sinA * radius * 0.75

      // --- glyph target: the anchor plus its bounded internal drift -----------
      let tx = cometX
      let ty = cometY
      let tz = cometZ
      if (glyphMix > 0) {
        const gx = glyph[idx] + s.iconOrbitOffsets[idx]
        const gy = glyph[idx + 1] + s.iconOrbitOffsets[idx + 1]
        const gz = glyph[idx + 2] + s.iconOrbitOffsets[idx + 2]
        // Blend the two shapes: the transition is what makes the change read as the
        // cloud gathering rather than as a cut.
        tx = cometX + (gx - cometX) * glyphMix
        ty = cometY + (gy - cometY) * glyphMix
        tz = cometZ + (gz - cometZ) * glyphMix
      }

      let vx = velocities[idx]
      let vy = velocities[idx + 1]
      let vz = velocities[idx + 2]

      if (useHoldStep) {
        stepVoxSpaceHoldParticle(velocities, idx, px, py, pz, tx, ty, tz, followSpeed, frameStep)
        vx = velocities[idx]
        vy = velocities[idx + 1]
        vz = velocities[idx + 2]
      } else {
        vx = vx * COMET_VELOCITY_MEMORY + (tx - px) * followSpeed * frameStep
        vy = vy * COMET_VELOCITY_MEMORY + (ty - py) * followSpeed * frameStep
        vz = vz * COMET_VELOCITY_MEMORY + (tz - pz) * followSpeed * frameStep
        velocities[idx] = vx
        velocities[idx + 1] = vy
        velocities[idx + 2] = vz
      }

      if (pointerActive) {
        applyVoxSpacePointerPush(velocities, idx, px, py, pz, i / count, s.pointerField)
        vx = velocities[idx]
        vy = velocities[idx + 1]
        vz = velocities[idx + 2]
      }

      vx *= friction
      vy *= friction
      vz *= friction
      velocities[idx] = vx
      velocities[idx + 1] = vy
      velocities[idx + 2] = vz

      const nx = px + vx
      const ny = py + vy
      const nz = pz + vz
      positions[idx] = nx
      positions[idx + 1] = ny
      positions[idx + 2] = nz

      // --- colour -----------------------------------------------------------
      // Dark theme is a white-hot head cooling down the tail, with the site's
      // single warm accent mixed in at the head only — a comet reads as white-hot,
      // and a saturated head would fight the glyph it forms.
      const headness = 1 - t
      const warm = glyphMix > 0 ? glyphMix * 0.26 : headness * headness * 0.55
      const depth = Math.max(-1, Math.min(1, nz / 1.4)) * this.holdFade
      const shimmer = 0.86 + Math.sin(time * 2.1 + s.tailSeed[i] * 43.0) * 0.05 + depth * 0.08
      const lum = (0.42 + headness * 0.72 + Math.abs(depth) * 0.06) * shimmer * palette.gain

      const cr = (palette.core.r + (palette.accent.r - palette.core.r) * warm) * lum
      const cg = (palette.core.g + (palette.accent.g - palette.core.g) * warm) * lum
      const cb = (palette.core.b + (palette.accent.b - palette.core.b) * warm) * lum

      const cap = this.light ? 0.82 : 1.4
      colors[idx] = cr > cap ? cap : cr
      colors[idx + 1] = cg > cap ? cap : cg
      colors[idx + 2] = cb > cap ? cap : cb
    }
  }

  private upload(): void {
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.getAttribute('color').needsUpdate = true
  }

  private advanceCamera(): void {
    const span = DOLLY_TO_Z - DOLLY_FROM_Z
    const period = DOLLY_PERIOD_SECONDS + DOLLY_WRAP_SECONDS
    const t = this.reducedMotion ? 0 : this.dollySeconds % period

    let progress: number
    if (t < DOLLY_PERIOD_SECONDS) {
      progress = t / DOLLY_PERIOD_SECONDS
    } else {
      // Eased wrap back to the near end; the starfield recycles stars as the camera
      // passes them, so this reads as the field catching up rather than a cut.
      progress = 1 - smootherStep((t - DOLLY_PERIOD_SECONDS) / DOLLY_WRAP_SECONDS)
    }

    const z = Math.max(DOLLY_FROM_Z + span * progress, this.fitDistance)
    this.camera.position.set(0, 0, z)
    this.camera.lookAt(0, 0, 0)
  }

  private publishStats(now: number): void {
    // Sliding mean over the last 30 frames, in a preallocated ring so the
    // diagnostic itself does not allocate per frame.
    this.frameTimes[this.frameCursor] = now
    this.frameCursor = (this.frameCursor + 1) % this.frameTimes.length
    if (this.frameCount < this.frameTimes.length) this.frameCount += 1
    if (this.frameCount > 1) {
      const oldest =
        this.frameCount < this.frameTimes.length
          ? this.frameTimes[0]
          : this.frameTimes[this.frameCursor]
      const span = now - oldest
      if (span > 0) this.stats.fps = ((this.frameCount - 1) * 1000) / span
    }

    const info = this.renderer.info
    this.stats.particleCount = this.particleCount
    this.stats.phase = this.choreography.state.phase
    this.stats.brandSlug = this.currentBrandSlug
    this.stats.drawCalls = info.render.calls
    this.stats.triangles = info.render.triangles
    // Positions and colours are the only GPU-resident buffers the cloud owns.
    this.stats.geometryBytes =
      this.geometry.getAttribute('position').array.byteLength +
      this.geometry.getAttribute('color').array.byteLength

    if (typeof window !== 'undefined') {
      // The external acceptance harness reads this. It is the same object every
      // frame, so publishing it allocates nothing.
      const holder = window as unknown as Record<string, unknown>
      holder.__SUB2API_PARTICLE_STATS__ = this.stats
    }
  }
}
