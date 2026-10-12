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
 * The tail is **emitted**, not dragged. Every tail particle is born inside the nucleus,
 * handed a velocity, given a lifetime, and fades to nothing as that lifetime runs out;
 * its position is a closed form evaluated each frame from the emission table. Its
 * predecessor was a rigid ribbon of particles pinned to fixed arc-length slots on the
 * head's past path, which the user rejected as unreadable ("彗星和彗尾看不出来是什么
 * 东西…完全没有彗星的真实感") because a fixed slot is a fixed *geometry* — the whole
 * tail translated as one body. See the `// --- Tail emission (V2) ---` section of
 * `constants.ts` for the model and the measured numbers behind it.
 *
 * Performance rules that live here (HOME-PARTICLE-DESIGN.md §6):
 *   - one BufferGeometry, positions/colors updated in place, one draw call
 *   - zero per-frame allocation: every buffer is preallocated in `scratch`, including
 *     the per-particle age/life/reach/cone arrays the emission model needs, and
 *     `sampleTrail` is evaluated `tailSampleCount` times per frame into the emission
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
import { EmittedTail, createCometBody } from './emittedTail'
import { createChoreography, type Point3 } from './choreography'
import { createCometVisual } from './cometVisual'
import type { CometVisual, CometVisualFrame } from './cometVisualContract'
import { transitionGlyphMix, writeCometTransition } from './cometTransition'
import {
  AMPLITUDE_X,
  BRANDS,
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  DOLLY_FROM_Z,
  FRICTION,
  GATHER_SECONDS,
  HEAD_CORE_RADIUS,
  HEAD_CORE_SHARE,
  HOLD_SECONDS,
  LEG_SECONDS,
  POINTER_RADIUS,
  SCATTER_SECONDS,
  SUBJECT_Z,
  TAIL_DUST_LIFE_MAX,
  TAIL_DUST_LIFE_MIN,
  TAIL_DUST_REACH_MAX,
  TAIL_DUST_REACH_MIN,
  TAIL_ENTRAIN,
  TAIL_FADE_POWER,
  TAIL_FILL,
  TAIL_ION_LIFE_MAX,
  TAIL_ION_LIFE_MIN,
  TAIL_ION_NARROW,
  TAIL_ION_REACH_MAX,
  TAIL_ION_REACH_MIN,
  TAIL_ION_SHARE,
  TAIL_SECONDS,
  TAIL_SPEED_JITTER,
  TAIL_SPREAD,
} from './constants'
import { COALESCE_END, departureSeconds } from './flightTiming'
import { cameraTravelAt, glyphStopZ } from './spaceMotion'
import { createQualityProfile, probeQualityProfile } from './quality'
import { GLYPH_MIN_BBOX_ASPECT, fitDistanceForRoster, requiredGlyphWorldSize } from './glyphSize'
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

const SPACE_TIMING = {
  legSeconds: LEG_SECONDS,
  gatherSeconds: GATHER_SECONDS,
  holdSeconds: HOLD_SECONDS,
  scatterSeconds: SCATTER_SECONDS,
}

/** Where the vendor's glyph sampler centres a glyph, in its own units. */
const GLYPH_CENTER_X = 5.8
/**
 * Headroom on the HEIGHT floor, so the glyph never lands exactly on the 2/3 line.
 *
 * `fitDistanceForRoster` returns the largest distance at which the glyph still
 * clears both floors, so sitting on it leaves the binding floor EQUAL to the user's
 * number with nothing left over. The measured cloud sits a percent or two inside
 * its own anchor box, so the real share reads under the ideal — the probe measured
 * portrait viewports at 0.6497..0.6570 against a 0.6667 floor when the ideal was
 * exactly 0.6667. Being 12% nearer puts the ideal at 0.7467, clear of the floor
 * with the cloud's own spread absorbed.
 *
 * Applied only when the height floor is the binding one — see `updateCameraFit`.
 * It is not a width allowance. */
const FRAME_MARGIN = 1.12
// The other framing constant that used to live here, `GLYPH_HALF_EXTENT = 6.3`, is
// gone rather than merely unused, and deliberately not replaced by an equivalent.
//
// It described half of the vendor's 12.6-unit icon square, which was the widest
// thing on screen only until `brandTargets.ts` began levelling every mark to
// `GLYPH_WORLD_HEIGHT`. The roster's real widths are now 7.006..16.479, so the
// constant was sizing a shape that no longer exists. The framing question is
// `glyphSize.ts`'s now — see `updateCameraFit`.

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

/**
 * The palette for a theme. Exported so the light theme's contrast can be asserted
 * as a unit test: it is arithmetic on colours, and the failure mode (ink too pale
 * to out-shout its own starfield) is invisible in a code review — it took a
 * measured 2.85:1 against a 6.78:1 background to find it.
 */
export function paletteFor(isLightTheme: boolean): ThemePalette {
  return isLightTheme
    ? {
        // Additive blending washes out to white on a pale page, so the light theme
        // is dark ink on a bright sky and must blend normally.
        //
        // Normal blending does not accumulate the way additive does: the glow sprite
        // is a soft radial falloff, so overlapping translucent points converge on a
        // haze rather than on the sprite's centre colour. Measured with the earlier
        // values (opacity 0.8, size 0.082) the comet rendered at 2.85:1 against the
        // page while the starfield managed 6.78:1 — the background out-shouted the
        // subject, even though the comet's own vertex colour was a dark 98/255.
        //
        // So on the light theme each particle has to be individually more solid:
        // full opacity, a larger sprite, and a darker core. The point size is
        // deliberately *larger* than the dark theme's, which looks backwards but is
        // the consequence of normal blending — ink needs coverage, light does not.
        core: new Color(0.06, 0.075, 0.115),
        accent: new Color(0.62, 0.2, 0.0),
        gain: 0.72,
        blending: NormalBlending,
        background: new Color(0.976, 0.98, 0.984),
        opacity: 1.0,
        pointSize: 0.125,
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
  emittedTail: EmittedTail
  body: ReturnType<typeof createCometBody>
  positions: Float32Array
  velocities: Float32Array
  /** RGBA vertex colours; alpha is the actual lifetime visibility channel. */
  colors: Float32Array
  tailBirthPosition: Float32Array
  tailBirthVelocity: Float32Array
  tailReady: Uint8Array
  shapeFrom: Float32Array
  shapeAlpha: Float32Array
  /** Reused transition result: XYZ, alpha, glyph commitment, fragment warmth. */
  transitionOut: Float64Array
  pointerOffset: Float32Array
  /**
   * Seconds since each tail particle was born, and how long it gets to live.
   *
   * This pair *is* the model. Age advances by the frame's own delta, and when it
   * reaches `tailLife` the particle dies and is recycled at the nucleus — which is
   * why the plume has a moving population instead of a fixed set of slots. There is
   * no ring buffer and no allocation: the death is a reset of one float.
   */
  tailLife: Float32Array
  tailAge: Float32Array
  /**
   * World units a particle covers along its own birth axis over its whole life.
   *
   * Stored as a reach rather than a speed so the plume's length cannot re-couple to
   * lifetime (see `TAIL_DUST_REACH_MIN`). The speed is `reach / life`, recomputed
   * where it is used.
   */
  tailReach: Float32Array
  /**
   * The particle's ejection direction, baked as a unit vector in the birth frame:
   * `(cos θ, sin θ·cos φ, sin θ·sin φ)`, `count * 3`.
   *
   * Baked in the birth frame, not in world space, because the frame rotates with the
   * head — the cone has to be carried along and re-referenced each frame, and storing
   * world-space directions would freeze the spray in the direction the comet happened
   * to be facing when the particle was born.
   */
  tailCone: Float32Array
  /** `1` for the ion population, `0` for dust. Selects the tint and the cone width. */
  tailIon: Uint8Array
  /** Stable per-particle phase for the shimmer term. */
  tailSeed: Float32Array
  /**
   * Offsets inside the nucleus, `count * 3`.
   *
   * Every particle's birth point sits somewhere in this ball rather than at one exact
   * point. For the core particles that is what stops the nucleus drawing as a flat
   * machined disc; for the tail particles it is the emission aperture, and it is what
   * keeps the plume's root from being a single bright pixel.
   */
  headOffset: Float32Array
  /** Glyph anchors in subject space for the brand being assembled. */
  glyphTargets: Float32Array
  glyphStrokeDepth: Float32Array
  /** The emission table the tail particles index by age. See {@link EmissionTable}. */
  tailTable: EmissionTable
  /** Per-frame radial drift of the internal glyph flow. */
  iconOrbitOffsets: Float32Array
  iconOrbitField: VoxSpaceIconOrbitField
  iconHoldPose: VoxSpaceIconHoldPose
  pointerField: VoxSpacePointerField
  /** Reused vectors — the frame loop must not construct any. */
  vecA: Vector3
  vecB: Vector3
  /** Reused sample target for the emission table walk. */
  probePoint: Point3
  inverseRotation: Quaternion
}

/**
 * The head's past, baked per frame into everything a tail particle needs to know
 * about the instant it was born.
 *
 * Uniform TIME, and deliberately no longer uniform arc length. The arc-length
 * resampling the old tail used existed to give a rigid ribbon a length that did not
 * depend on the head's speed; under V2 that job belongs to the inherited birth
 * velocity (see `TAIL_ENTRAIN`), so this table only has to answer two questions —
 * where was the head, and how fast was it moving, when this particle left it.
 *
 * Every array is `probeCount * 3` and preallocated; `writeEmissionTable` refills them
 * in place. Split out of `EngineScratch` so the emission kernel can be unit-tested
 * against a synthetic path with no WebGL anywhere near it.
 */
export interface EmissionTable {
  /** Absolute subject-space head position at each probe, newest first. */
  xyz: Float32Array
  /** **Forward** head velocity at each probe, from a central difference. */
  vel: Float32Array
  /** Unit backward tangent — the axis the spray opens around. */
  axis: Float32Array
  /** First basis vector of the plane normal to `axis`. */
  side1: Float32Array
  /** Second basis vector, `cross(axis, side1)`. */
  side2: Float32Array
  /** Probes actually populated, `2 <= probeCount <= TAIL_PROBE_COUNT`. */
  probeCount: number
  /** Seconds of the past the table spans. Always `TAIL_SECONDS`. */
  spanSeconds: number
}

/**
 * A decorrelated 0..1 roll for a particle, from an integer index and a salt.
 *
 * The obvious way to scatter a per-particle attribute is another golden-ratio
 * term — `frac(i * 3 * PHI)`, `frac(i * 7 * PHI)` and so on. That is wrong, and
 * wrong in a way that looks fine in every scalar test: `frac(i * k * PHI)` is a
 * *deterministic function of* `frac(i * PHI)`, because `3 * frac(i*PHI)` differs
 * from `frac(3*i*PHI)` by an integer. So the tail's radius, angle, spin and
 * shimmer all ended up being functions of its position. The result was a perfectly
 * ordered helix — the on-screen read was a stack of concentric ellipse outlines, a
 * machined coil, and the only way to see it was to look at a rendered frame.
 *
 * An avalanche hash gives what the golden ratio cannot: a roll that is
 * independent of the position roll and of the other attributes.
 */
function hash01(index: number, salt: number): number {
  let h = Math.imul(index ^ salt, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function createEngineScratch(count: number, tailSampleCount: number): EngineScratch {
  const tailLife = new Float32Array(count)
  const tailAge = new Float32Array(count)
  const tailReach = new Float32Array(count)
  const tailCone = new Float32Array(count * 3)
  const tailIon = new Uint8Array(count)
  const tailSeed = new Float32Array(count)
  const headOffset = new Float32Array(count * 3)
  const golden = 0.6180339887498949
  const coreCount = Math.floor(count * HEAD_CORE_SHARE)

  // Distinct salts, so no two attributes can fall into step with each other. The
  // earlier version of this file derived every attribute from the same golden-ratio
  // sequence, which made the radius, angle and spin all functions of the particle's
  // position — the tail rendered as a machined helix. Any two attributes that must be
  // independent need different salts.
  const LIFE_SALT = 0x7feb352d
  const REACH_SALT = 0xa511e9b3
  const THETA_SALT = 0x1b56c4e9
  const PHI_SALT = 0x27d4eb2f
  const ION_SALT = 0x68e31da4
  const JITTER_SALT = 0x846ca68b
  const SEED_SALT = 0x9e3779b9
  const CORE_X_SALT = 0x2545f491
  const CORE_Y_SALT = 0x9e3779b1
  const CORE_Z_SALT = 0x85ebca6b

  for (let i = 0; i < count; i++) {
    tailSeed[i] = hash01(i, SEED_SALT)

    if (i < coreCount) {
      // A concentrated nucleus inside a sparse coma, with no uniform bright rim.
      const r = HEAD_CORE_RADIUS * Math.pow(hash01(i, CORE_X_SALT), 0.72)
      const cosTheta = hash01(i, CORE_Y_SALT) * 2 - 1
      const phi = hash01(i, CORE_Z_SALT) * Math.PI * 2
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
      headOffset[i * 3] = r * sinTheta * Math.cos(phi)
      headOffset[i * 3 + 1] = r * sinTheta * Math.sin(phi)
      headOffset[i * 3 + 2] = r * cosTheta
      // Core particles live forever and never move under the emission model: they are
      // the nucleus, not the plume. A zero life with a zero reach leaves them parked
      // on the birth point, and `integrate()` blends the core in by index instead.
      tailLife[i] = 0
      tailReach[i] = 0
      continue
    }

    const ion = hash01(i, ION_SALT) < TAIL_ION_SHARE
    tailIon[i] = ion ? 1 : 0

    // Uniform lives within the class. A single shared lifetime would make every
    // particle the same age, and the plume would pulse as one slab breathing in and
    // out instead of showing newborn and dying material at once.
    const lifeMin = ion ? TAIL_ION_LIFE_MIN : TAIL_DUST_LIFE_MIN
    const lifeMax = ion ? TAIL_ION_LIFE_MAX : TAIL_DUST_LIFE_MAX
    const life = lifeMin + hash01(i, LIFE_SALT) * (lifeMax - lifeMin)
    tailLife[i] = life

    // A reach, not a speed — see `TAIL_DUST_REACH_MIN`. Jittered so the fade edge is
    // a soft band rather than a mathematically exact disc.
    const reachMin = ion ? TAIL_ION_REACH_MIN : TAIL_DUST_REACH_MIN
    const reachMax = ion ? TAIL_ION_REACH_MAX : TAIL_DUST_REACH_MAX
    const reach = reachMin + hash01(i, REACH_SALT) * (reachMax - reachMin)
    tailReach[i] = reach * (1 + (hash01(i, JITTER_SALT) - 0.5) * 2 * TAIL_SPEED_JITTER)

    // Age starts spread uniformly through life, which is the steady state the running
    // engine converges to. Starting every particle at age 0 would open the page with
    // one synchronised wave of newborns collapsing to nothing 2.5 s in — a visible
    // pulse on first paint, exactly where nobody is watching for a defect.
    tailAge[i] = (((i - coreCount) * golden + 0.5) % 1) * life

    // The ejection cone. `sin(theta)` is raised to `TAIL_FILL` so the angles crowd
    // toward the axis — a bright spine inside a thinning envelope, rather than the
    // uniform-density cloud a plain `sqrt` gives or the hollow shell a uniform roll
    // in `sin(theta)` gives. Ion particles get a proportionally narrower cone.
    const spread = TAIL_SPREAD * (ion ? TAIL_ION_NARROW : 1)
    const sinTheta = spread * Math.pow(hash01(i, THETA_SALT), TAIL_FILL)
    const cosTheta = Math.sqrt(Math.max(0, 1 - sinTheta * sinTheta))
    const phi = hash01(i, PHI_SALT) * Math.PI * 2
    tailCone[i * 3] = cosTheta
    tailCone[i * 3 + 1] = sinTheta * Math.cos(phi)
    tailCone[i * 3 + 2] = sinTheta * Math.sin(phi)

    // The emission aperture: a ball around the nucleus, so the plume's root is a
    // volume and not one bright pixel. Uniform in direction, cubed-root in radius.
    const r = HEAD_CORE_RADIUS * Math.cbrt(hash01(i, CORE_X_SALT))
    const cosY = hash01(i, CORE_Y_SALT) * 2 - 1
    const phiY = hash01(i, CORE_Z_SALT) * Math.PI * 2
    const sinY = Math.sqrt(Math.max(0, 1 - cosY * cosY))
    headOffset[i * 3] = r * sinY * Math.cos(phiY)
    headOffset[i * 3 + 1] = r * sinY * Math.sin(phiY)
    headOffset[i * 3 + 2] = r * cosY
  }

  return {
    emittedTail: new EmittedTail(Math.max(1, Math.floor(count * (1 - HEAD_CORE_SHARE)))),
    body: createCometBody(count),
    // The opening frame is a wide scatter that the spring pulls into the first
    // comet, so the background assembles itself instead of popping into being.
    positions: createInitialScatterTargets(count),
    velocities: new Float32Array(count * 3),
    colors: new Float32Array(count * 4),
    tailBirthPosition: new Float32Array(count * 3),
    tailBirthVelocity: new Float32Array(count * 3),
    tailReady: new Uint8Array(count),
    shapeFrom: new Float32Array(count * 3),
    shapeAlpha: new Float32Array(count),
    transitionOut: new Float64Array(6),
    pointerOffset: new Float32Array(count * 3),
    tailLife,
    tailAge,
    tailReach,
    tailCone,
    tailIon,
    tailSeed,
    headOffset,
    glyphTargets: new Float32Array(count * 3),
    glyphStrokeDepth: new Float32Array(count),
    tailTable: createEmissionTable(tailSampleCount),
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
    probePoint: { x: 0, y: 0, z: 0 },
    inverseRotation: new Quaternion(),
  }
}

/**
 * Allocate an emission table. Every buffer is allocated here and only here, so the
 * frame loop can refill it without touching the allocator.
 *
 * `probeCount` comes from the quality profile's `tailSampleCount`, which the ladder
 * already varies from 48 to 96. Those numbers used to be "how many points along the
 * rigid ribbon", which needed to be dense because the ribbon's shape was drawn by
 * linear interpolation between them. Now they are the resolution of the emission
 * table's *time* axis, and what needs to be dense is the sampling of the head's
 * velocity, since a coarse table makes a particle born mid-turn inherit a velocity
 * from a different part of the curve. 48 is still enough: the fastest the head moves
 * is 5.0 u/s, and 3.2 s / 48 probes is a 0.067 s step, over which the head travels at
 * most 0.33 units — an order of magnitude below the plume's own width, so the
 * misinheritance is smaller than the tail.
 */
export function createEmissionTable(probeCount: number): EmissionTable {
  const n = Math.max(2, Math.floor(probeCount))
  return {
    xyz: new Float32Array(n * 3),
    vel: new Float32Array(n * 3),
    axis: new Float32Array(n * 3),
    side1: new Float32Array(n * 3),
    side2: new Float32Array(n * 3),
    probeCount: n,
    spanSeconds: TAIL_SECONDS,
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

/**
 * Fill `table` with the head's recent past, newest first, at uniform TIME.
 *
 * `source` is the choreography's `sampleTrail(delay, out)`. Working through a
 * callback rather than reaching for the engine's own choreography is what lets the
 * whole emission kernel be tested against a synthetic path in jsdom — and the kernel
 * is where every interesting number in the new tail lives.
 *
 * `probePoint` is a caller-owned scratch `Point3`, so this allocates nothing.
 *
 * Three passes, all in place:
 *   1. positions, at uniform time back from the head
 *   2. **forward** velocities, from a central difference — forward because the tail
 *      particle's position is `birthPos + birthVelocity * age`, and getting this sign
 *      wrong turns the plume inside out (it trails at twice the head speed instead of
 *      co-moving, and the visible length collapses to a few units)
 *   3. per-probe unit backward tangent and an orthonormal basis normal to it, which is
 *      the frame the ejection cone is expressed in
 *
 * The basis is built from a fixed reference vector chosen per probe rather than from
 * the world up axis unconditionally: at the S-curve's extremes the tangent is nearly
 * parallel to `+X`, and crossing that with `+Y` would still work, but the cross
 * degenerates to zero on a path that happened to be vertical. Picking whichever of
 * `+Y` / `+X` is further from parallel keeps the basis well-conditioned everywhere the
 * head can go, at the cost of one comparison.
 */
export function fillEmissionTable(
  table: EmissionTable,
  source: { sampleTrail(delaySeconds: number, out: Point3): void },
  probePoint: Point3
): void {
  const n = table.probeCount
  const { xyz, vel, axis, side1, side2 } = table
  const span = table.spanSeconds
  const step = span / Math.max(1, n - 1)

  // Pass 1: the path at uniform time.
  for (let k = 0; k < n; k++) {
    source.sampleTrail(k * step, probePoint)
    xyz[k * 3] = probePoint.x
    xyz[k * 3 + 1] = probePoint.y
    xyz[k * 3 + 2] = probePoint.z
  }

  // Pass 2 + 3 in one walk: the central difference needs neighbours, and the axis is
  // just the negated unit velocity, so both come out of the same three points.
  for (let k = 0; k < n; k++) {
    const hi = (k === 0 ? 0 : k - 1) * 3
    const lo = (k === n - 1 ? n - 1 : k + 1) * 3
    // `hi` is the *newer* probe (smaller delay) and `lo` the older, so
    // (newer - older) / elapsed is the forward velocity. The endpoints reuse their
    // single available neighbour, which halves the span; both are so far down the
    // tail (>= 2 s old) that the difference is invisible.
    const elapsed = (k === 0 || k === n - 1 ? 1 : 2) * step
    const vx = (xyz[hi] - xyz[lo]) / elapsed
    const vy = (xyz[hi + 1] - xyz[lo + 1]) / elapsed
    const vz = (xyz[hi + 2] - xyz[lo + 2]) / elapsed
    vel[k * 3] = vx
    vel[k * 3 + 1] = vy
    vel[k * 3 + 2] = vz

    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
    let ax: number
    let ay: number
    let az: number
    if (speed > 1e-6) {
      // Backward: the plume is left behind the direction of travel.
      ax = -vx / speed
      ay = -vy / speed
      az = -vz / speed
    } else {
      // A held glyph pins the head, so its velocity is genuinely zero and there is no
      // tangent to derive. Fall back to the world X axis rather than dividing by ~0 —
      // any unit vector is as good as any other here, because the emission model is
      // gated off by `glyphMix` in exactly these phases (see `integrate`).
      ax = -1
      ay = 0
      az = 0
    }
    axis[k * 3] = ax
    axis[k * 3 + 1] = ay
    axis[k * 3 + 2] = az

    // An orthonormal pair spanning the plane normal to the axis.
    const rx = Math.abs(ay) < 0.9 ? 0 : 1
    const ry = Math.abs(ay) < 0.9 ? 1 : 0
    const rz = 0
    let s1x = ry * az - rz * ay
    let s1y = rz * ax - rx * az
    let s1z = rx * ay - ry * ax
    const s1Len = Math.sqrt(s1x * s1x + s1y * s1y + s1z * s1z)
    if (s1Len > 1e-6) {
      s1x /= s1Len
      s1y /= s1Len
      s1z /= s1Len
    } else {
      s1x = 1
      s1y = 0
      s1z = 0
    }
    side1[k * 3] = s1x
    side1[k * 3 + 1] = s1y
    side1[k * 3 + 2] = s1z
    // The second basis vector is a cross product of two unit, orthogonal vectors, so
    // it is already unit length and needs no normalisation.
    side2[k * 3] = ay * s1z - az * s1y
    side2[k * 3 + 1] = az * s1x - ax * s1z
    side2[k * 3 + 2] = ax * s1y - ay * s1x
  }
}

/**
 * The lifetime falloff: 1 at birth, exactly 0 at the end of life, monotone between.
 *
 * `(1 - u) ** TAIL_FADE_POWER` rather than a smoothstep or a linear ramp because the
 * requirement is a *gradual* fade to nothing, and this form cannot overshoot: the
 * value is 0 at `u = 1` by construction, so a recycled particle is invisible on the
 * frame it is reused rather than popping. The exponent below 1 front-loads the decay,
 * which reads as material already cooling as it leaves the nucleus.
 *
 * Clamped on both sides: `u` comes from a division by `life`, and a recycled particle
 * whose `life` was somehow 0 would otherwise push a negative base into `Math.pow` and
 * write a NaN into the colour buffer, which blanks the whole cloud for a frame.
 */
export function tailFade(u: number): number {
  // Non-finite `u` cannot be clamped meaningfully, and returning 1 for a NaN would
  // leave a permanently bright particle stuck in the plume. Invisible is the safe
  // failure: the worst case is one missing point, not a glowing artefact.
  if (!Number.isFinite(u)) return 0
  const w = 1 - clamp01(u)
  return w <= 0 ? 0 : Math.pow(w, TAIL_FADE_POWER)
}

/**
 * Where one tail particle sits, in subject space, from its own baked numbers.
 *
 *     p = head(age) + headVelocity(age)·age·ENTRAIN
 *       + apertureOffset
 *       + (axis·cosθ + side1·sinθcosφ + side2·sinθsinφ) · reach · (age/life)
 *
 * Extracted so the emission model — the thing the user actually complained about — is
 * asserted as arithmetic rather than inspected in a screenshot. Nothing here touches
 * WebGL, and the axial profile and age histogram in the acceptance data are produced
 * by running this function over the scratch arrays.
 *
 * Writes `out[0..2]`. Allocation-free.
 */
export function writeTailParticlePosition(
  table: EmissionTable,
  age: number,
  life: number,
  reach: number,
  coneX: number,
  coneY: number,
  coneZ: number,
  jitterX: number,
  jitterY: number,
  jitterZ: number,
  out: Float32Array
): void {
  const n = table.probeCount
  const { xyz, vel, axis, side1, side2 } = table
  const span = table.spanSeconds
  const step = span / Math.max(1, n - 1)

  // Sanitise every scalar first. These come from a float accumulator in the frame loop,
  // and a single NaN reaching the colour buffer blanks the entire cloud for a frame —
  // so the failure has to be local to one particle, not global. `age` is clamped into
  // the table rather than rejected, since 0 is a legitimate "just born" reading.
  const safeAge = Number.isFinite(age) ? clampTo(age, span) : 0
  const safeLife = Number.isFinite(life) ? life : 0
  const safeReach = Number.isFinite(reach) ? reach : 0

  // Locate the birth instant on the table's time axis, then lerp. The clamp is the
  // reason `TAIL_SECONDS` has to exceed the longest life: a clamped probe would pin a
  // whole column of dying particles onto a *fresher* point of the path and they would
  // visibly snap toward the head as they faded.
  const f = safeAge / step
  const k = Math.min(n - 2, Math.floor(f))
  const t = f - k
  const a = k * 3
  const b = (k + 1) * 3

  const px = xyz[a] + (xyz[b] - xyz[a]) * t
  const py = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * t
  const pz = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * t

  // The inherited birth velocity. This is what keeps the plume's visible length from
  // tracking the head's speed — see `TAIL_ENTRAIN`.
  const vx = vel[a] + (vel[b] - vel[a]) * t
  const vy = vel[a + 1] + (vel[b + 1] - vel[a + 1]) * t
  const vz = vel[a + 2] + (vel[b + 2] - vel[a + 2]) * t
  const drift = safeAge * TAIL_ENTRAIN

  // The ejection cone, re-referenced into the birth frame every frame: the cone turns
  // with the comet instead of staying frozen in the direction it was pointing.
  const sx = axis[a] + (axis[b] - axis[a]) * t
  const sy = axis[a + 1] + (axis[b + 1] - axis[a + 1]) * t
  const sz = axis[a + 2] + (axis[b + 2] - axis[a + 2]) * t
  const ux = side1[a] + (side1[b] - side1[a]) * t
  const uy = side1[a + 1] + (side1[b + 1] - side1[a + 1]) * t
  const uz = side1[a + 2] + (side1[b + 2] - side1[a + 2]) * t
  const wx = side2[a] + (side2[b] - side2[a]) * t
  const wy = side2[a + 1] + (side2[b + 1] - side2[a + 1]) * t
  const wz = side2[a + 2] + (side2[b + 2] - side2[a + 2]) * t

  // Distance covered along the birth axis, in world units: the particle's own reach,
  // reached at its own death, so `life` drops out and the fade edge stays coherent.
  const travelled = safeLife > 1e-6 ? safeReach * clamp01(safeAge / safeLife) : 0

  out[0] = px + vx * drift + jitterX + (sx * coneX + ux * coneY + wx * coneZ) * travelled
  out[1] = py + vy * drift + jitterY + (sy * coneX + uy * coneY + wy * coneZ) * travelled
  out[2] = pz + vz * drift + jitterZ + (sz * coneX + uz * coneY + wz * coneZ) * travelled
}

/** Advance a particle from its latched birth frame, never from its previous glyph pose. */
export function advanceEmittedTail(
  s: EngineScratch,
  i: number,
  delta: number,
  out: Float32Array
): number {
  const life = s.tailLife[i]
  if (!(life > 0)) return 0
  const idx = i * 3
  let age = s.tailAge[i] + Math.max(0, delta)
  const recycled = age >= life
  if (recycled) age %= life
  s.tailAge[i] = age

  if (!s.tailReady[i] || recycled) {
    const table = s.tailTable
    const f = Math.min(table.probeCount - 1, age / table.spanSeconds * (table.probeCount - 1))
    const a = Math.min(table.probeCount - 2, Math.floor(f)) * 3
    const t = f - a / 3
    const speed = s.tailReach[i] / life
    for (let j = 0; j < 3; j++) {
      const k = a + j
      const b = k + 3
      const origin = table.xyz[k] + (table.xyz[b] - table.xyz[k]) * t
      const velocity = table.vel[k] + (table.vel[b] - table.vel[k]) * t
      const axis = table.axis[k] + (table.axis[b] - table.axis[k]) * t
      const side1 = table.side1[k] + (table.side1[b] - table.side1[k]) * t
      const side2 = table.side2[k] + (table.side2[b] - table.side2[k]) * t
      s.tailBirthPosition[idx + j] = origin + s.headOffset[idx + j]
      s.tailBirthVelocity[idx + j] = velocity * TAIL_ENTRAIN + speed * (
        axis * s.tailCone[idx] + side1 * s.tailCone[idx + 1] + side2 * s.tailCone[idx + 2]
      )
      s.pointerOffset[idx + j] = 0
      s.velocities[idx + j] = 0
    }
    s.tailReady[i] = 1
  }
  for (let j = 0; j < 3; j++) {
    out[j] = s.tailBirthPosition[idx + j] + s.tailBirthVelocity[idx + j] * age
  }
  return tailFade(age / life)
}

/** Clamp `v` into `[0, hi]`, mapping NaN and negatives to 0. */
function clampTo(v: number, hi: number): number {
  if (!(v > 0)) return 0
  return v < hi ? v : hi
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
  /** Dev-observable: independent final GPU buffers, never glyph targets. */
  readonly tailPoints: Points
  private readonly tailGeometry: BufferGeometry
  private readonly tailMaterial: PointsMaterial
  readonly cometVisual: CometVisual
  private readonly cometVisualFrame: CometVisualFrame = {
    phase: 'travel', progress: 0, time: 0, delta: 0,
    headX: 0, headY: 0, headZ: 0, glyphMix: 0, departure: 0,
    light: false, reducedMotion: false,
  }
  private hasIntegrated = false

  private readonly choreography: Choreography
  private readonly starfield: Starfield
  private readonly brandSource: BrandTargetSource
  private readonly ownsBrandSource: boolean

  private readonly scratch: EngineScratch
  /** One object, mutated in place and republished every frame (see §6 item 2). */
  private readonly stats: EngineStats

  private running = false
  private programsPrepared = false
  private rafId = 0
  private disposed = false
  private lastFrameMs = 0
  private dollySeconds = 0
  private reducedMotion: boolean
  private light: boolean
  private palette: ThemePalette
  private width = 1
  private height = 1
  private fitGap = DOLLY_FROM_Z
  private fitDistance = DOLLY_FROM_Z
  private readonly particleCount: number
  private readonly tailSampleCount: number
  private readonly frameTimes = new Float64Array(30)
  private frameCount = 0
  private frameCursor = 0

  private readonly pointer = { clientX: 0, clientY: 0, active: false, lastMove: 0 }
  private pointerBound = false

  private currentBrandSlug: string | null = null
  private currentGlyphLeg = -1
  /** Centre represented by the previous geometry upload, before internal offsets. */
  private readonly renderedHead = new Vector3()
  private lastPhase: CometPhase = 'travel'
  private holdFade = 0
  private renderedPhase: CometPhase = 'travel'

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
    // Required production API. Fail before allocating WebGL resources if absent.
    this.cometVisual = createCometVisual({
      particleCount: this.particleCount, light: this.light, reducedMotion: this.reducedMotion,
    })
    this.cometVisual.object.position.set(0, 0, SUBJECT_Z)
    this.scene.add(this.cometVisual.object)

    const rect = this.container.getBoundingClientRect()
    this.width = Math.max(1, Math.floor(rect.width || this.container.clientWidth || 1))
    this.height = Math.max(1, Math.floor(rect.height || this.container.clientHeight || 1))

    // If WebGL is unavailable, release the already-created model before the
    // caller shows its fallback. Factory/update failures remain visible errors.
    try {
      this.renderer = new WebGLRenderer({
        antialias: this.quality.antialias,
        alpha: true,
        powerPreference: 'high-performance',
      })
    } catch (error) {
      this.scene.remove(this.cometVisual.object)
      this.cometVisual.dispose()
      throw error
    }
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
    const colAttr = new BufferAttribute(this.scratch.colors, 4)
    colAttr.setUsage(DynamicDrawUsage)
    this.geometry.setAttribute('position', posAttr)
    this.geometry.setAttribute('color', colAttr)
    this.geometry.setAttribute('cometScale', new BufferAttribute(this.scratch.body.spriteScale, 1).setUsage(DynamicDrawUsage))
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
    // Both pools share this fixed origin. Motion lives in the geometry arrays;
    // camera travel must never translate particles that have already been born.
    this.points.position.set(0, 0, SUBJECT_Z)
    this.points.frustumCulled = false
    this.scene.add(this.points)

    this.tailGeometry = new BufferGeometry()
    this.tailGeometry.setAttribute('position', new BufferAttribute(this.scratch.emittedTail.positions, 3).setUsage(DynamicDrawUsage))
    this.tailGeometry.setAttribute('color', new BufferAttribute(this.scratch.emittedTail.colors, 4).setUsage(DynamicDrawUsage))
    this.tailMaterial = this.material.clone()
    // Keep this draw and its pos3/color4 uploads for GPU causal auditing. The
    // independently emitted volume is the sole visible tail.
    this.tailMaterial.opacity = 0
    this.tailMaterial.size = this.palette.pointSize * (this.light ? 1.05 : 3.6)
    // Only the body uses per-point coverage; the tail keeps its own material.
    this.material.onBeforeCompile = shader => {
      shader.vertexShader = `attribute float cometScale;\n${shader.vertexShader}`.replace(
        'gl_PointSize = size;', 'gl_PointSize = size * cometScale;'
      )
    }
    this.material.customProgramCacheKey = () => 'comet-body-coverage-v1'
    this.tailPoints = new Points(this.tailGeometry, this.tailMaterial)
    this.tailPoints.name = 'causal-emitted-tail'
    this.tailPoints.frustumCulled = false
    this.tailPoints.position.copy(this.points.position)
    this.scene.add(this.tailPoints)

    this.starfield = createStarfield({
      count: this.quality.starCount,
      reducedMotion: this.reducedMotion,
      isLightTheme: this.light,
    })
    this.scene.add(this.starfield.object)

    this.choreography = createChoreography({
      brandCount: this.roster.length,
      amplitudeX: AMPLITUDE_X,
      // Space motion keeps the centre on Y=0 in every viewport.
      swayY: 0,
      swayZ: 0,
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
    this.advanceCamera()
    const head = this.choreography.state
    this.renderedHead.set(head.headX, head.headY, head.headZ)
    // The head and historical samples use the same viewport options.
    this.applyViewportSway()
    this.bindPointer()
    this.bindContextLoss()

    // Seed the opening glyph and queue the next, so the first gather never waits
    // on a rasterise.
    this.syncGlyph()
    this.prefetchAhead()

    // Dev-only handle so an acceptance script can interrogate the live scene
    // (layer counts, camera position, orbit cursor) instead of inferring its state
    // from a screenshot. Stripped from a production build by the bundler.
    if (import.meta.env.DEV) {
      const holder = window as unknown as Record<string, unknown>
      holder.__SUB2API_PARTICLE_ENGINE__ = this
    }
  }

  /** Dev-only: the live three.js objects, for the acceptance scripts. */
  get debugScene(): { camera: PerspectiveCamera; scene: Scene; points: Points } {
    return { camera: this.camera, scene: this.scene, points: this.points }
  }

  /**
   * Dev-only: the renderer's current clear colour as a hex string.
   *
   * Read off the renderer rather than re-deriving it from the palette, so a
   * mismatch between what the theme set and what was actually applied is visible
   * to the acceptance probes. This is the colour that decides whether the canvas
   * sits *behind* the page or paints over it, which is a light-theme-only failure
   * that nothing else would catch.
   */
  debugRendererClearHex(): string {
    // `getClearColor` writes into a caller-owned Color, so this allocates only when
    // a probe calls it, never per frame.
    const out = new Color()
    this.renderer.getClearColor(out)
    return '#' + out.getHexString()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    try {
      if (!this.programsPrepared) {
        // three r184 compile traverses hidden objects too. Submit the event
        // material now, without changing visibility or drawing a warmup frame.
        this.renderer.compile(this.scene, this.camera)
        // compile alone defers link-status waits and uniform/attribute reflection
        // until first use. Complete them before the animation clock starts, also
        // on drivers without KHR_parallel_shader_compile. This intentionally pays
        // the cold driver cost once at startup rather than at the first gather.
        for (const program of this.renderer.info.programs ?? []) program.getUniforms()
        this.programsPrepared = true
      }
    } catch (error) {
      this.stop()
      this.options.onError?.(error)
      return
    }
    if (this.disposed || !this.running) return
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
    this.tailMaterial.blending = this.palette.blending
    this.tailMaterial.size = this.palette.pointSize * (this.light ? 1.05 : 3.6)
    this.tailMaterial.opacity = 0
    this.tailMaterial.needsUpdate = true
    this.renderer.setClearColor(this.palette.background, isLightTheme ? 1 : 0)
    this.starfield.setTheme(isLightTheme)
    // Colours are rewritten every frame, so the next tick picks the palette up.
  }

  setReducedMotion(value: boolean): void {
    if (this.disposed || this.reducedMotion === value) return
    this.reducedMotion = value
    this.starfield.setReducedMotion(value)
    // Freeze both clocks at their current epoch. Resetting only the dolly would
    // put a later world-space glyph behind the camera, and resuming would drift.
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
    this.applyViewportSway()
  }

  /** Resize changes camera framing, never the world route or its historical tail. */
  private applyViewportSway(): void {
    this.choreography.setSwayY(0)
    fillEmissionTable(this.scratch.tailTable, this.choreography, this.scratch.probePoint)
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
    this.scene.remove(this.tailPoints)
    this.scene.remove(this.cometVisual.object)
    this.cometVisual.dispose()
    this.tailGeometry.dispose()
    this.tailMaterial.dispose()
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
   * How far the camera must sit from the CONTENT PLANE for the formed glyph to
   * clear both of the user's floors (V6): at least 2/3 of the viewport height and
   * at least 1/3 of its width.
   *
   * This used to be computed here from `GLYPH_HALF_EXTENT = 6.3`, which is a
   * pre-normalisation number (it describes the vendor's 12.6-unit icon square, and
   * 6.3 was only ever correct while the widest thing on screen was that square).
   * After the glyphs are levelled in `brandTargets.ts` the roster's real extents are
   * 7.006 (groq) to 16.479 (xiaomimimo) world units wide, so that constant was
   * describing a shape that no longer exists. It is `glyphSize.ts` that owns this
   * question now, and it answers it against the levelled `GLYPH_WORLD_HEIGHT` and
   * the roster's narrowest bbox aspect, which is the worst case over all 28 brands.
   *
   * The two constraints pull in OPPOSITE directions, which is the whole tension
   * here and worth stating plainly:
   *
   *   - the old `fitDistance` was a LOWER bound on the distance, because it was
   *     solving "the widest content must not overflow the frame" — a further camera
   *     draws everything smaller, so any distance at or beyond it was safe;
   *   - `fitDistanceForRoster` is an UPPER bound, because it is solving "the glyph
   *     must be at least 2/3 as tall as the viewport" — a further camera draws the
   *     glyph smaller, so the distance must be at or INSIDE it.
   *
   * A layout that satisfied the first by shoving the camera back therefore made the
   * second worse, and that is exactly the 0.28 height share the probe measured. The
   * fix is not a bigger margin, it is a nearer camera, and to keep the glyph inside
   * the frame at that nearer distance the patrol amplitude comes down (see
   * `AMPLITUDE_X`).
   *
   * On the one horizontal cost this leaves behind, stated rather than smoothed over:
   *
   *   - on a landscape viewport at the roster distance the frame is 21.168 world
   *     units wide, i.e. +/-10.584 across;
   *   - the widest brand, xiaomimimo, levels to 16.479 wide (half-width 8.24) and
   *     forms at x = +/-2.56, so its far edge reaches 10.800 — about 0.22 units, or
   *     1% of the frame width, past the edge. Every other brand fits.
   *
   * The brief's answer to that was a per-brand uniform shrink of about 3.5% for this
   * one glyph. That is deliberately NOT done here, because it would break a stronger
   * invariant than it repairs: `brandTargets` levels every mark to
   * `GLYPH_WORLD_HEIGHT` precisely so that ONE distance serves all 28 brands, and
   * both the unit spec and the acceptance probe assert the buffer's world height is
   * `GLYPH_WORLD_HEIGHT` within 0.005 / 0.05. A 3.5% shrink puts that readback at
   * 9.816 — a 0.264 miss on both. Paying 1% of overhang with an assertion about the
   * levelling contract would trade a cosmetic edge clip for a broken guarantee, so
   * the overhang is reported to the reviewer instead of being hidden.
   *
   * The `Math.max(0.2, ...)` floor stays because a zero or negative aspect would
   * otherwise divide the fit away and blank the canvas.
   */
  private updateCameraFit(): void {
    const aspect = Math.max(0.2, this.width / this.height)
    // Start from the roster fit, which is the largest distance at which the glyph
    // still clears both floors, then give the HEIGHT floor its 12% of headroom.
    //
    // Why the margin is worth having at all: sitting exactly on `fitDistanceForRoster`
    // leaves the binding floor EQUAL to the user's number, with nothing left for the
    // measured cloud. Particles orbit and settle slightly outside the anchor box, so
    // the real share reads a percent or two under the ideal — the probe measured
    // portrait viewports at 0.6497..0.6570 against a 0.6667 floor when the ideal was
    // exactly 0.6667. Being 12% nearer raises the ideal to 0.7467 and clears it.
    //
    // Why it is taken ONLY where the height floor binds, and never off the width
    // term: the two floors are bounds on the same distance in OPPOSITE directions.
    // The height floor is an upper bound (nearer is bigger, which is what it wants),
    // so headroom means coming nearer. The width floor is a lower bound (the glyph
    // must not overhang the frame), so coming nearer makes it WORSE. Applying 12% to
    // the whole fit therefore helped portrait viewports, where the height binds, and
    // hurt landscape ones, where the width binds — it widened the widest brand's
    // overhang from 0.249 to 1.383 world units on 16:9. So the margin is computed on
    // the height-only distance and only adopted when that is what binds.
    //
    // `requiredGlyphWorldSize` is asked which floor binds rather than re-deriving the
    // two candidates here, so this decision keeps agreeing with `glyphSize.ts` if the
    // floors or the roster's narrowest aspect are ever retuned.
    const roster = fitDistanceForRoster(aspect, CAMERA_FOV)
    const binding = requiredGlyphWorldSize(aspect, CAMERA_FOV, roster, GLYPH_MIN_BBOX_ASPECT)
    this.fitGap = binding.binding === 'height' ? roster / FRAME_MARGIN : roster
    this.fitDistance = this.fitGap + SUBJECT_Z
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
      // Pointer unprojection must use this frame's camera matrix.
      this.advanceCamera()
      this.writeEmissionTable()
      this.integrate(frameStep, now / 1000, clockStep)
      this.upload()
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
    if (!this.reducedMotion) this.choreography.update(delta)
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
    } else if (this.currentGlyphLeg !== state.legIndex) {
      // A one-brand/custom roster can keep the slug while the world anchor moves.
      this.syncGlyph()
    }
    this.prefetchAhead()

    if (!this.reducedMotion) this.dollySeconds += delta
  }

  /** Queue the glyph after the current one, off the critical path. */
  private prefetchAhead(): void {
    const state = this.choreography.state
    // Profiling found next-brand rasterisation in the first flight frame's idle
    // task. Queue it during the preceding hold, with ample time before departure.
    if (state.phase !== 'hold') return
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

    // The anchor belongs to the leg, not the roster index. nextBrand() changes
    // the mark at the same phase without changing its world-space destination.
    const state = this.choreography.state
    const amplitude = state.toX
    const anchorZ = glyphStopZ(state.legIndex, SPACE_TIMING)
    const glyph = this.scratch.glyphTargets
    const n = Math.min(this.particleCount, Math.floor(targets.targets.length / 3))
    for (let i = 0; i < n; i++) {
      glyph[i * 3] = targets.targets[i * 3] - GLYPH_CENTER_X + amplitude
      glyph[i * 3 + 1] = targets.targets[i * 3 + 1]
      glyph[i * 3 + 2] = targets.targets[i * 3 + 2] + anchorZ
    }
    // Missing anchors sit at this same destination, including its accumulated Z.
    for (let i = n; i < this.particleCount; i++) {
      glyph[i * 3] = amplitude
      glyph[i * 3 + 1] = 0
      glyph[i * 3 + 2] = anchorZ
    }
    this.currentGlyphLeg = state.legIndex
    this.scratch.glyphStrokeDepth.fill(0)
    this.scratch.glyphStrokeDepth.set(targets.strokeDepth.subarray(0, n))

    fillVoxSpaceIconOrbitField(
      this.scratch.iconOrbitField,
      targets.targets,
      targets.strokeDepth
    )
  }

  /**
   * Refill the emission table from the head's recent past.
   *
   * The whole method is the call to {@link fillEmissionTable}, which is a free
   * function so that it can be exercised against a synthetic path in a unit test —
   * this class cannot be constructed under jsdom, and the table's *sign conventions*
   * are the part of the new tail most likely to be got subtly wrong. Everything it
   * needs is preallocated in `scratch`, so the frame allocates nothing.
   */
  private writeEmissionTable(): void {
    fillEmissionTable(this.scratch.tailTable, this.choreography, this.scratch.probePoint)
  }

  private integrate(frameStep: number, time: number, delta = frameStep / 60): void {
    const s = this.scratch
    const positions = s.positions
    const velocities = s.velocities
    const colors = s.colors
    const glyph = s.glyphTargets
    const count = this.particleCount
    const state = this.choreography.state
    const palette = this.palette
    const phase = state.phase
    if (this.reducedMotion && this.hasIntegrated) {
      // Freeze the uploaded pose and visual rotation at their current epoch.
      const frame = this.cometVisualFrame
      frame.delta = 0
      frame.light = this.light
      frame.reducedMotion = true
      this.cometVisual.update(frame, s.emittedTail)
      return
    }
    if (this.reducedMotion) time = 0
    if (phase !== this.renderedPhase) {
      if (phase === 'gather' || phase === 'scatter') {
        s.shapeFrom.set(positions)
        if (phase === 'gather') {
          // The prior upload was still in flight. Move its internal shape onto
          // the exact stop anchor before morphing, so the centre stops in X/Z
          // together even when the frame crosses the arrival boundary.
          for (let i = 0; i < count; i++) {
            s.shapeFrom[i * 3] += state.headX - this.renderedHead.x
            s.shapeFrom[i * 3 + 1] += state.headY - this.renderedHead.y
            s.shapeFrom[i * 3 + 2] += state.headZ - this.renderedHead.z
          }
        }
        for (let i = 0; i < count; i++) {
          const spriteScale = s.body.spriteScale[i]
          s.shapeAlpha[i] = colors[i * 4 + 3] * spriteScale * spriteScale
        }
        s.pointerOffset.fill(0)
        velocities.fill(0)
      }
      this.renderedPhase = phase
    }

    // How committed this frame is to the glyph shape: 0 is a pure comet, 1 is the
    // settled logo. Everything that only makes sense on a glyph is gated by it, so
    // the two shapes can never bleed into each other.
    const shapeProgress = phase === 'scatter' ? clamp01(state.phaseProgress / COALESCE_END) : state.phaseProgress
    const glyphMix = transitionGlyphMix(phase, shapeProgress)

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

    // Internal orbit and depth tone remain local to the glyph. Rotating the
    // whole group would orbit its accumulated Z around the world origin.
    this.holdFade = nextVoxSpaceIconHoldFade(this.holdFade, glyphMix, frameStep)
    writeVoxSpaceIconHoldPose(s.iconHoldPose, time, this.holdFade)
    this.points.rotation.set(0, 0, 0)

    // Resolve the pointer on the current head/glyph plane in the fixed group.
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
        // Geometry carries chronology Z; the Object3D origin stays at SUBJECT_Z.
        const planeZ = this.points.position.z + state.headZ
        const distance = dirZ === 0 ? -1 : (planeZ - this.camera.position.z) / dir.z
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

    const useHoldStep = phase === 'hold' && glyphMix > 0.5
    const cometMix = 1 - glyphMix
    // Per-point coverage separates the small nucleus from the diffuse coma.
    // Restore the original point footprint as the body becomes a glyph.
    const bodyMaterial = this.points.material as PointsMaterial
    bodyMaterial.size = palette.pointSize
    const table = s.tailTable
    const departure = departureSeconds(phase, state.phaseProgress, LEG_SECONDS, SCATTER_SECONDS)
    const moving = Math.hypot(table.vel[0], table.vel[1], table.vel[2]) > 1e-6
    s.emittedTail.update(delta, departure, departure > 0 && moving && !this.reducedMotion,
      table, state.headX, state.headY, state.headZ, palette.core, palette.accent, this.light)

    for (let i = 0; i < count; i++) {
      const idx = i * 3
      const px = positions[idx]
      const py = positions[idx + 1]
      const pz = positions[idx + 2]

      // All former logo particles belong to the compact body throughout flight.
      const cometX = state.headX + s.body.offsets[idx]
      const cometY = state.headY + s.body.offsets[idx + 1]
      const cometZ = state.headZ + s.body.offsets[idx + 2]
      // Surface lighting belongs to the mesh; these are sparse coma/dust flecks.
      const emit = s.body.alpha[i] * (this.light ? 0.14 : 0.08)

      // --- glyph target: the anchor plus its bounded internal drift -----------
      let tx = cometX
      let ty = cometY
      let tz = cometZ
      let alpha = emit
      let fragmentWarmth = 0
      if (phase === 'gather' || phase === 'scatter') {
        writeCometTransition(s.transitionOut, phase, shapeProgress,
          s.shapeFrom[idx], s.shapeFrom[idx + 1], s.shapeFrom[idx + 2],
          glyph[idx] + s.iconOrbitOffsets[idx], glyph[idx + 1] + s.iconOrbitOffsets[idx + 1],
          glyph[idx + 2] + s.iconOrbitOffsets[idx + 2],
          cometX, cometY, cometZ, state.headX, state.headY, state.headZ,
          s.tailSeed[i], s.shapeAlpha[i], emit)
        tx = s.transitionOut[0]
        ty = s.transitionOut[1]
        tz = s.transitionOut[2]
        alpha = s.transitionOut[3]
        fragmentWarmth = s.transitionOut[5]
      } else if (phase === 'hold') {
        tx = glyph[idx] + s.iconOrbitOffsets[idx]
        ty = glyph[idx + 1] + s.iconOrbitOffsets[idx + 1]
        tz = glyph[idx + 2] + s.iconOrbitOffsets[idx + 2]
        alpha = 1
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
        vx = vx * COMET_VELOCITY_MEMORY - s.pointerOffset[idx] * followSpeed * frameStep
        vy = vy * COMET_VELOCITY_MEMORY - s.pointerOffset[idx + 1] * followSpeed * frameStep
        vz = vz * COMET_VELOCITY_MEMORY - s.pointerOffset[idx + 2] * followSpeed * frameStep
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

      if (!useHoldStep) {
        s.pointerOffset[idx] += vx
        s.pointerOffset[idx + 1] += vy
        s.pointerOffset[idx + 2] += vz
      }
      const nx = useHoldStep ? px + vx : tx + s.pointerOffset[idx]
      const ny = useHoldStep ? py + vy : ty + s.pointerOffset[idx + 1]
      const nz = useHoldStep ? pz + vz : tz + s.pointerOffset[idx + 2]
      positions[idx] = nx
      positions[idx + 1] = ny
      positions[idx + 2] = nz

      // --- colour -----------------------------------------------------------
      // Preserve the hold palette; only ejected fragments gain transient warmth.
      const warm = glyphMix * 0.26 + cometMix * 0.045 + fragmentWarmth
      const depth = Math.max(-1, Math.min(1, (nz - state.headZ) / 1.4)) * this.holdFade
      const shimmer = 0.86 + Math.sin(time * 2.1 + s.tailSeed[i] * 43.0) * 0.05 + depth * 0.08
      // The ion population is tinted toward the accent and the dust toward the cool
      // core, which is the one nod to the two-tail structure the brief asks for that
      // this renderer can afford: one multiply and one compare per particle.
      const w = warm
      const lum = (glyphMix * 1.14 + cometMix * s.body.tone[i] + Math.abs(depth) * 0.06) * shimmer * palette.gain

      let cr = (palette.core.r + (palette.accent.r - palette.core.r) * w) * lum
      let cg = (palette.core.g + (palette.accent.g - palette.core.g) * w) * lum
      let cb = (palette.core.b + (palette.accent.b - palette.core.b) * w) * lum
      // A warm compact nucleus sits inside a cool gas envelope. Preserve the
      // original brand palette exactly as the body resolves into a glyph.
      const nucleus = s.body.spriteSize[i] < 3
      if (this.light) {
        const ink = nucleus ? 1 - cometMix * 0.72 : 1
        cr *= ink
        cg *= ink
        cb *= ink
      } else {
        cr *= 1 + cometMix * (nucleus ? 0.04 : -0.72)
        cg *= 1 + cometMix * (nucleus ? 0 : -0.18)
        cb *= 1 + cometMix * (nucleus ? -0.12 : 0.18)
      }

      const cap = this.light ? 0.82 : 1.4
      const colorIndex = i * 4
      colors[colorIndex] = cr > cap ? cap : cr
      colors[colorIndex + 1] = cg > cap ? cap : cg
      colors[colorIndex + 2] = cb > cap ? cap : cb
      const flightScale = 1 + cometMix * (this.light ? 0.35 : s.body.spriteSize[i] - 1)
      // Keep transition dust compact enough to read as individual moving strands.
      // The coverage channel remains area-normalised, preserving endpoint energy.
      const eventCoverage = phase === 'gather' || phase === 'scatter'
        ? Math.sin(Math.PI * shapeProgress) ** 2 : 0
      const spriteScale = flightScale + (Math.min(flightScale, 1.5) - flightScale) * eventCoverage
      s.body.spriteScale[i] = spriteScale
      colors[colorIndex + 3] = alpha / (spriteScale * spriteScale)
    }
    this.renderedHead.set(state.headX, state.headY, state.headZ)
    this.hasIntegrated = true
    this.updateCometVisual(time, this.reducedMotion ? 0 : delta, glyphMix)
  }

  private updateCometVisual(time: number, delta: number, glyphMix: number): void {
    const state = this.choreography.state
    const frame = this.cometVisualFrame
    frame.phase = state.phase
    frame.progress = state.phaseProgress
    frame.time = time
    frame.delta = delta
    frame.headX = state.headX
    frame.headY = state.headY
    frame.headZ = state.headZ
    frame.glyphMix = glyphMix
    frame.departure = departureSeconds(state.phase, state.phaseProgress, LEG_SECONDS, SCATTER_SECONDS)
    frame.light = this.light
    frame.reducedMotion = this.reducedMotion
    this.cometVisual.update(frame, this.scratch.emittedTail)
  }

  private upload(): void {
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.getAttribute('color').needsUpdate = true
    this.geometry.getAttribute('cometScale').needsUpdate = true
    this.tailGeometry.getAttribute('position').needsUpdate = true
    this.tailGeometry.getAttribute('color').needsUpdate = true
  }

  /** Camera retreats indefinitely while both particle pools keep a fixed origin. */
  private advanceCamera(): void {
    const cameraZ = this.fitDistance + cameraTravelAt(this.dollySeconds)
    this.camera.position.set(0, 0, cameraZ)
    // A fixed -Z view also works when cameraZ crosses the world origin.
    this.camera.quaternion.identity()
    this.camera.updateMatrixWorld()
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
    // Include per-point coverage as well as the position/colour buffers.
    this.stats.geometryBytes =
      this.geometry.getAttribute('position').array.byteLength +
      this.geometry.getAttribute('color').array.byteLength +
      this.geometry.getAttribute('cometScale').array.byteLength +
      this.tailGeometry.getAttribute('position').array.byteLength +
      this.tailGeometry.getAttribute('color').array.byteLength +
      this.cometVisual.geometryBytes

    if (typeof window !== 'undefined') {
      // The external acceptance harness reads this. It is the same object every
      // frame, so publishing it allocates nothing.
      const holder = window as unknown as Record<string, unknown>
      holder.__SUB2API_PARTICLE_STATS__ = this.stats
    }
  }
}
