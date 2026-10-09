/**
 * LANE L3 — deep-space starfield.
 *
 * R1 asks for a "深邃无垠的宇宙深空、繁星璀璨" backdrop and R2 dollies the camera away
 * from the comet for the whole session. This module owns the second half of that
 * picture: a parallax field of stars that never runs out as the camera retreats,
 * plus a faint nebula wash that gives the darkness some depth.
 *
 * Structure
 * ---------
 * `object` is a `Group` holding exactly four `Points` children:
 *
 *   [0] near stars   [1] mid stars   [2] far stars   [3] nebula wash
 *
 * Four is a fixed number, not a function of the environment: the wash is always
 * present because the code below must always have the same tree to dispose. Four
 * draw calls also leaves room for the comet inside §6's budget of six.
 *
 * Depth, and why the group moves
 * ------------------------------
 * Star positions live in the group's own space, so the CPU never rewrites them:
 * the camera's retreat is expressed by moving the group, and a star's distance in
 * front of the camera is `NEAR_DEPTH + travelled - localZ`. Stars therefore
 * recede for free and only the rare star crossing the far edge of its own band
 * has its `z` rewritten and its buffer re-uploaded.
 *
 * `travelled` is what makes the group positionable at all. `cameraZ` is *not*
 * monotonic — `DOLLY_PERIOD_SECONDS` ends with an eased wrap back to
 * `DOLLY_FROM_Z`. Driving the group from raw `cameraZ` would turn that wrap into
 * a 19-unit jump shared by every star at once. Accumulating only the *increase*
 * gives a monotonic `travelled`, so the wrap cancels out of
 * `group.position.z = cameraZ - travelled` and never reaches a star — which is
 * the "the starfield recycles stars to hide the reset" note in `constants.ts`.
 *
 * The three star bands occupy disjoint depth ranges (near 60..240, mid 240..500,
 * far 500..880). Overlapping ranges would let a "far" star drift close to the
 * lens and read as a near one, flattening the very parallax the layers exist for.
 * 880 also stays inside `CAMERA_FAR` (900), so no star is ever clipped away.
 *
 * Why the spread is per-star and proportional to depth
 * ---------------------------------------------------
 * Each star is placed at `lateral = SPREAD * sqrt(u) * depth`. Because screen
 * offset is `lateral / depth`, that expression makes every star's *screen* radius
 * `SPREAD * sqrt(u)` regardless of its depth: `sqrt` gives uniform area coverage,
 * so the first frame is an evenly seeded sky rather than a sparse rim around an
 * empty middle. Sampling a fixed world-space disc instead would either crowd the
 * frame at one end of the band or leave it half empty at the other.
 *
 * Brightness carries the illusion
 * -------------------------------
 * Both ends of every band are faded to zero. The far end hides the departure, the
 * near end hides the arrival — and the near end matters twice over, because a star
 * that recycled to depth ~60 under `sizeAttenuation` would otherwise balloon into
 * a screen-filling blob. The same per-star factor is where "繁星璀璨" comes from:
 * every star gets its own brightness and twinkle phase, so the field reads as many
 * stars rather than one material.
 *
 * Note that the outward-then-inward convergence this produces is not an artefact:
 * translating backwards makes everything drift toward the vanishing point, which
 * is exactly what "镜头不断拉远" should look like.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  NormalBlending,
  Points,
  PointsMaterial,
} from 'three'
import type { Texture } from 'three'
import { BASE_STAR_COUNT } from './constants'
import type { Starfield, StarfieldOptions } from './types'

/**
 * The page background this field is drawn against, for whichever lane owns the
 * scene. `object` cannot set a clear colour (that belongs to `ParticleEngine`),
 * so the palette is published rather than silently assumed.
 */
export const STARFIELD_SPACE_COLOR_DARK = '#03040a'
export const STARFIELD_SPACE_COLOR_LIGHT = '#f8fafc'

const TAU = Math.PI * 2

/** Share of the total that ends up in the near / mid / far layer. */
const NEAR_SHARE = 0.28
const MID_SHARE = 0.32

/**
 * Nebula blobs, as a share of the total and an absolute cap. Small, because the
 * wash is made by a few very large points; capped, because ~26 blobs already
 * covers the frame and scaling with a high-quality profile would only stack
 * transparent overdraw on top of itself.
 */
const NEBULA_SHARE = 0.01
const NEBULA_MAX = 26

/**
 * Share of a band at each end where a star fades out and back in. The recycle
 * happens inside these margins, so the teleport itself is never visible.
 */
const FADE_MARGIN = 0.24

/**
 * Screen-space radius of the field, as the tangent of the angle from the view
 * axis. `CAMERA_FOV` is 44°, so at 16:9 the frame's half-tangents are 0.40
 * vertically and 0.72 horizontally: 0.85 fills the frame and spends its spare
 * stars just outside the left and right edges. A wider viewport than that leaves
 * its far corners slightly thinner, which is invisible against a fade-to-black
 * field and much cheaper than plumbing a live aspect ratio into a module whose
 * options are frozen.
 */
const STAR_SPREAD = 0.85

/** The wash deliberately overflows the frame, so it reads as depth, not a disc. */
const NEBULA_SPREAD = 1.5

/** Side of the glow sprite, in pixels. One texture shared by all four layers. */
const GLOW_TEXTURE_SIZE = 128

interface StarLayerPlan {
  /** Nearest and furthest this layer's stars may sit from the camera. */
  nearDepth: number
  farDepth: number
  /**
   * Point size in world units. It grows with the layer's depth to offset
   * `sizeAttenuation` — a single shared `size` would render the far layer below
   * one pixel and make it disappear.
   */
  size: number
  /** Depth-axis roll, radians per second. */
  spin: number
  /** Base brightness multiplier. */
  brightness: number
  /** How deep the per-star twinkle dips, 0..1. */
  twinkle: number
  /** Screen-space radius; only the wash differs from `STAR_SPREAD`. */
  spread: number
}

const STAR_PLANS: StarLayerPlan[] = [
  { nearDepth: 60, farDepth: 240, size: 1.6, spin: 0.02, brightness: 1, twinkle: 0.24, spread: STAR_SPREAD },
  { nearDepth: 240, farDepth: 500, size: 2.7, spin: 0.011, brightness: 0.88, twinkle: 0.32, spread: STAR_SPREAD },
  { nearDepth: 500, farDepth: 880, size: 3.8, spin: 0.006, brightness: 0.74, twinkle: 0.4, spread: STAR_SPREAD },
]

const NEBULA_PLAN: StarLayerPlan = {
  nearDepth: 600,
  farDepth: 850,
  size: 320,
  spin: 0.003,
  brightness: 1,
  twinkle: 0,
  spread: NEBULA_SPREAD,
}

interface Tint {
  rgb: readonly [number, number, number]
  weight: number
}

/**
 * Both palettes are built around neutrals. §2 reserves the single accent
 * (`#ff8447`) for the warm star, at a share low enough to read as a highlight
 * rather than a scheme — and nothing here is teal or cyan.
 */
const DARK_TINTS: Tint[] = [
  { rgb: [0.8, 0.87, 1], weight: 0.6 },
  { rgb: [0.95, 0.96, 1], weight: 0.22 },
  { rgb: [0.66, 0.75, 0.98], weight: 0.12 },
  { rgb: [1, 0.52, 0.28], weight: 0.06 },
]

/**
 * The light theme gets dark grey-blue stars under `NormalBlending`. Additive
 * stars on a pale page glow, which reads as a fake light source rather than as a
 * star, so the blending mode belongs to the theme rather than to a constant.
 */
const LIGHT_TINTS: Tint[] = [
  { rgb: [0.28, 0.32, 0.4], weight: 0.68 },
  { rgb: [0.41, 0.45, 0.55], weight: 0.26 },
  { rgb: [0.85, 0.4, 0.16], weight: 0.06 },
]

const DARK_NEBULA = new Color(0.13, 0.17, 0.3)
const LIGHT_NEBULA = new Color(0.62, 0.66, 0.74)

interface StarLayer {
  plan: StarLayerPlan
  /** Length of the depth band: how far a star travels before recycling. */
  band: number
  points: Points
  geometry: BufferGeometry
  material: PointsMaterial
  count: number
  /**
   * `x`, `y` are fixed for the layer's lifetime; `z` is the only component the
   * recycle ever rewrites.
   */
  positions: Float32Array
  /** Per-vertex brightness, unused (all zeros) on the wash. */
  colors: Float32Array
  baseRed: Float32Array
  baseGreen: Float32Array
  baseBlue: Float32Array
  twinkleRate: Float32Array
  twinklePhase: Float32Array
  /** Whether the layer shades per vertex, or just tints its whole material. */
  vertexShaded: boolean
  spinPhase: number
}

/** Resolves a `0..1` roll against a palette. */
function pickTint(tints: Tint[], roll: number): readonly [number, number, number] {
  let acc = 0
  for (const tint of tints) {
    acc += tint.weight
    if (roll <= acc) return tint.rgb
  }
  return tints[tints.length - 1].rgb
}

/**
 * Brightness for a star `t` of the way through its band, 0..1. Zero at both ends:
 * the near end hides the arrival (and the point-size blowup), the far end hides
 * the teleport.
 */
function depthFade(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const ramp = clamped < FADE_MARGIN ? clamped / FADE_MARGIN : 1
  return ramp * ramp * (1 - clamped * clamped)
}

function buildLayer(
  plan: StarLayerPlan,
  count: number,
  palette: Tint[],
  vertexShaded: boolean
): StarLayer {
  const band = plan.farDepth - plan.nearDepth
  const geometry = new BufferGeometry()
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const baseRed = new Float32Array(count)
  const baseGreen = new Float32Array(count)
  const baseBlue = new Float32Array(count)
  const twinkleRate = new Float32Array(count)
  const twinklePhase = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    // See the header: sizing the lateral offset from the star's own depth is what
    // makes the screen coverage even across the whole band.
    const depth = plan.nearDepth + Math.random() * band
    const lateral = plan.spread * Math.sqrt(Math.random()) * depth
    const theta = Math.random() * TAU
    positions[i * 3] = Math.cos(theta) * lateral
    positions[i * 3 + 1] = Math.sin(theta) * lateral
    // Seeded at `travelled = 0`, so the local z is simply `-depth`. Spread over
    // the whole band rather than shelled: the first frame should already be a
    // full sky, not one that has to travel into place.
    positions[i * 3 + 2] = -depth

    // One roll per star, reused by every palette, so a theme switch recolours the
    // same star instead of reshuffling which star is which colour.
    const tint = pickTint(palette, Math.random())
    // Per-star level variance is the cheap half of "繁星璀璨". Without it the
    // field is one flat material and reads as a texture, not as stars.
    const level = plan.brightness * (0.45 + Math.random() * 0.55)
    baseRed[i] = tint[0] * level
    baseGreen[i] = tint[1] * level
    baseBlue[i] = tint[2] * level

    twinkleRate[i] = 0.25 + Math.random() * 0.7
    twinklePhase[i] = Math.random() * TAU

    if (!vertexShaded) {
      // The wash keeps a single tint per blob; only the palette moves it.
      colors[i * 3] = 1
      colors[i * 3 + 1] = 1
      colors[i * 3 + 2] = 1
    }
  }

  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))

  const material = new PointsMaterial({
    // Per-vertex colour carries both the twinkle and the depth fade; a single
    // material colour could express neither.
    vertexColors: vertexShaded,
    size: plan.size,
    sizeAttenuation: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  })

  const points = new Points(geometry, material)
  // The layers are repositioned as a group every frame, so a bounding sphere
  // authored against the original transform would cull the whole field the moment
  // the group moved. With four objects the culling test earns nothing anyway.
  points.frustumCulled = false

  return {
    plan,
    band,
    points,
    geometry,
    material,
    count,
    positions,
    colors,
    baseRed,
    baseGreen,
    baseBlue,
    twinkleRate,
    twinklePhase,
    vertexShaded,
    spinPhase: 0,
  }
}

/**
 * One 128x128 radial falloff, shared by all four layers and released once. Drawn
 * from a canvas rather than shipped as a PNG so the feature adds no binary asset.
 * Where there is no 2D context (jsdom, or a canvas that refuses) the texture is
 * simply absent: each layer keeps its colour and blending and only loses the soft
 * edge.
 */
function createGlowTexture(): Texture | null {
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = GLOW_TEXTURE_SIZE
  canvas.height = GLOW_TEXTURE_SIZE

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    canvas.width = 0
    canvas.height = 0
    return null
  }

  const half = GLOW_TEXTURE_SIZE / 2
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.2, 'rgba(255,255,255,.9)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,.42)')
  gradient.addColorStop(0.78, 'rgba(255,255,255,.12)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE)

  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  // The texture owns a GPU upload, not the element, so the canvas can be released
  // straight away instead of holding a second copy of the same pixels.
  canvas.width = 0
  canvas.height = 0
  return texture
}

export function createStarfield(options: StarfieldOptions): Starfield {
  const total = Math.max(0, Math.floor(options.count ?? BASE_STAR_COUNT))
  let light = options.isLightTheme ?? false
  let reduced = options.reducedMotion ?? false

  // Split so the three shares sum to exactly `total`, including the tiny counts a
  // test or a reduced-motion profile asks for.
  const nearCount = Math.round(total * NEAR_SHARE)
  const midCount = Math.round(total * MID_SHARE)
  const farCount = Math.max(0, total - nearCount - midCount)
  const nebulaCount =
    total > 0 ? Math.max(1, Math.min(NEBULA_MAX, Math.round(total * NEBULA_SHARE))) : 0

  const glow = createGlowTexture()
  const palette = light ? LIGHT_TINTS : DARK_TINTS

  const layers: StarLayer[] = [
    buildLayer(STAR_PLANS[0], nearCount, palette, true),
    buildLayer(STAR_PLANS[1], midCount, palette, true),
    buildLayer(STAR_PLANS[2], farCount, palette, true),
    buildLayer(NEBULA_PLAN, nebulaCount, palette, false),
  ]

  const object = new Group()
  object.name = 'starfield'
  for (const layer of layers) {
    if (glow) layer.material.map = glow
    object.add(layer.points)
  }
  // The wash is behind everything. `renderOrder` is what enforces that in the
  // light theme, where normal blending makes paint order visible.
  layers[3].points.renderOrder = -1

  let travelled = 0
  let previousCameraZ: number | null = null
  let lastTime = 0
  let disposed = false

  /** Theme-dependent shading: palette, blending, opacity and haze colour. */
  function applyTheme(): void {
    const nextPalette = light ? LIGHT_TINTS : DARK_TINTS
    const blending = light ? NormalBlending : AdditiveBlending

    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index]
      layer.material.blending = blending
      layer.material.opacity =
        index === 0
          ? light
            ? 0.72
            : 0.95
          : index === 1
            ? light
              ? 0.66
              : 0.88
            : index === 2
              ? light
                ? 0.58
                : 0.78
              : 1
      if (!layer.vertexShaded) continue

      for (let i = 0; i < layer.count; i++) {
        const tint = pickTint(nextPalette, Math.random())
        // Deliberately a fresh level draw rather than the build-time one: a theme
        // switch then also reshuffles which stars are the bright ones, which reads
        // as a different sky instead of the same sky recoloured.
        const level = layer.plan.brightness * (0.45 + Math.random() * 0.55)
        layer.baseRed[i] = tint[0] * level
        layer.baseGreen[i] = tint[1] * level
        layer.baseBlue[i] = tint[2] * level
      }
    }

    const nebula = layers[3]
    nebula.material.color.copy(light ? LIGHT_NEBULA : DARK_NEBULA)
    nebula.material.opacity = light ? 0.035 : 0.09
  }

  /**
   * Recycles stars that have left their band. Writes `positions`, but uploads only
   * when something actually moved — a small minority of frames.
   */
  function wrapLayer(layer: StarLayer): void {
    const { positions, count, band } = layer
    const limit = travelled - layer.plan.farDepth
    let moved = false

    for (let i = 0; i < count; i++) {
      const zi = i * 3 + 2
      const localZ = positions[zi]
      if (localZ > limit) continue

      // Jump forward by whole bands to land back inside
      // `(travelled - farDepth, travelled - nearDepth]`. A closed form rather than
      // a loop: a backgrounded tab can hand us one enormous step, and looping
      // there would spin for millions of iterations inside a frame.
      const jumps = Math.floor((limit - localZ) / band) + 1
      positions[zi] = localZ + jumps * band
      moved = true
    }

    if (moved) layer.geometry.getAttribute('position').needsUpdate = true
  }

  /**
   * Writes the per-vertex colour: depth fade times twinkle times the star's own
   * palette entry. Allocates nothing.
   */
  function shadeLayer(layer: StarLayer, time: number, animate: boolean): void {
    const { positions, colors, count, band } = layer
    const nearDepth = layer.plan.nearDepth
    const twinkleDepth = animate ? layer.plan.twinkle : 0

    for (let i = 0; i < count; i++) {
      const depth = travelled - positions[i * 3 + 2]
      let level = depthFade((depth - nearDepth) / band)

      if (twinkleDepth > 0) {
        level *=
          1 -
          twinkleDepth *
            (0.5 + 0.5 * Math.sin(time * layer.twinkleRate[i] + layer.twinklePhase[i]))
      }

      const ci = i * 3
      colors[ci] = layer.baseRed[i] * level
      colors[ci + 1] = layer.baseGreen[i] * level
      colors[ci + 2] = layer.baseBlue[i] * level
    }

    // Unconditional: the fade is a function of depth, so this buffer changes on
    // every frame the camera is moving.
    layer.geometry.getAttribute('color').needsUpdate = true
  }

  applyTheme()
  // Bake once, so a field that is never animated (reduced motion, or a tab that
  // starts hidden) still shows its depth shading instead of an unshaded ring.
  wrapLayer(layers[3])
  for (const layer of layers.slice(0, 3)) {
    wrapLayer(layer)
    shadeLayer(layer, 0, false)
  }

  return {
    object,

    update(deltaSeconds: number, cameraZ: number, time: number): void {
      if (disposed) return
      lastTime = time

      const step = Number.isFinite(deltaSeconds) ? deltaSeconds : 0
      const position = Number.isFinite(cameraZ) ? cameraZ : (previousCameraZ ?? 0)
      // Only the retreat is accumulated, which is what keeps the dolly's wrap out
      // of the stars' geometry.
      if (previousCameraZ !== null && position > previousCameraZ) {
        travelled += position - previousCameraZ
      }
      previousCameraZ = position

      // Attaches the field to the real camera while the recycle maths runs on the
      // monotonic `travelled`.
      object.position.z = position - travelled

      const animate = !reduced
      if (animate) {
        for (const layer of layers) layer.spinPhase += step * layer.plan.spin
      }
      for (const layer of layers) {
        // Roll about z only. A yaw would rotate `x` into `z`, moving stars out of
        // the depth band their fade and recycle are computed from — for a star at
        // radius 200 and 45° of yaw that is a 140-unit error, larger than the
        // near layer's entire band. A roll leaves `z` untouched, so the authored
        // depth stays the rendered depth.
        layer.points.rotation.z = layer.spinPhase
      }

      for (const layer of layers.slice(0, 3)) {
        wrapLayer(layer)
        shadeLayer(layer, time, animate)
      }
      // The wash carries a hand-authored colour rather than a palette, so it is
      // only recycled, never re-shaded.
      wrapLayer(layers[3])
    },

    setTheme(isLightTheme: boolean): void {
      if (disposed || light === isLightTheme) return
      light = isLightTheme
      applyTheme()
      // Re-bake now, so a paused page (reduced motion, hidden tab) still recolours
      // instead of waiting for a frame that may never come.
      for (const layer of layers.slice(0, 3)) {
        shadeLayer(layer, lastTime, !reduced)
      }
    },

    setReducedMotion(value: boolean): void {
      if (disposed || reduced === value) return
      reduced = value
      // The stars stop rolling and stop twinkling. The depth shading stays,
      // because dropping it would make the field pop every time a star recycled.
      if (value) {
        for (const layer of layers.slice(0, 3)) shadeLayer(layer, lastTime, false)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      // This module registers no listeners, observers or timers — there is nothing
      // to detach, so the release is geometry, material and texture only.
      for (const layer of layers) {
        object.remove(layer.points)
        layer.geometry.dispose()
        layer.material.dispose()
      }
      glow?.dispose()
      layers.length = 0
      object.clear()
    },
  }
}
