/**
 * LANE L2 — quality ladder.
 *
 * Picks the rung of the quality ladder a device can actually afford, so a
 * software rasteriser never gets 18000 particles and a desktop with a discrete GPU
 * is not quietly held back at 5000. See HOME-PARTICLE-DESIGN.md §6 item 4.
 *
 * Three quarters of this file is defensiveness, on purpose. Every hint it reads is
 * optional in some browser (`deviceMemory` is Chromium-only, `hardwareConcurrency`
 * is missing in some embedded WebViews, `matchMedia` has been known to throw), and
 * every failure mode is "the canvas never appears". Nothing here may throw, and
 * nothing here may return NaN.
 *
 * Unit-testable by design: `readDeviceHints()` is the only impure part, and
 * `probeQualityProfile()` takes the hints as an optional second argument, so the
 * ladder itself is a pure function of (viewWidth, hints).
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

// ---------------------------------------------------------------------------
// Rung values that `constants.ts` does not name
// ---------------------------------------------------------------------------
//
// `constants.ts` is frozen, so the ladder's own numbers live here. The three
// particle counts it does name (BASE / ADAPTIVE / MIN) are used verbatim; the rest
// interpolate between them so a rung is always a strict step down from the one
// above it — an engine that reads two rungs must never see the weaker one ask for
// *more* of anything.

/** Below MIN_PARTICLE_COUNT: the software-rasteriser rung. 5000 CPU-updated points
 *  is already ~20 ms/frame on SwiftShader, so this rung is about staying responsive,
 *  not about looking good. */
const SOFTWARE_PARTICLE_COUNT = 3000
/** Between LOW_DPR and MAX_DPR: ~44% fewer fragments than 1.5 on a 2x display. */
const MID_DPR = 1.25
/** Star counts step down with the particle budget; stars are cheap per instance but
 *  they are still blended fragments, which is what a software rasteriser cannot do. */
const MID_STAR_COUNT = 1700
const LOW_STAR_COUNT = 900
const SOFTWARE_STAR_COUNT = 420
/** Rasterising a glyph mask at 760² costs ~578k `getImageData` reads per brand
 *  (§6 item 7). Weaker devices get a proportionally cheaper mask. */
const MID_ICON_CANVAS_SIZE = 640
const LOW_ICON_CANVAS_SIZE = 512
const SOFTWARE_ICON_CANVAS_SIZE = 384
/** Trail samples: 96 on high (the tail stays smooth when it whips through a turn),
 *  48 on the weaker rungs (the tail is a blur there anyway). */
const MID_TAIL_SAMPLE_COUNT = 72
const LOW_TAIL_SAMPLE_COUNT = 48

/**
 * Fill-rate ceiling, in fragment columns (`viewWidth * effectiveDpr`).
 *
 * What actually blows the frame budget on a big display is not the particle count
 * but the number of fragments the GPU must blend; a 4K wall at DPR 1.25 is 4800
 * columns, ~1.9x a 1080p monitor at the same ratio. 4200 columns is roughly the
 * point where the additive pass stops being free on integrated graphics, so past
 * it we step down a rung — and the step down also lowers the DPR cap, which is
 * what brings the column count back under the ceiling.
 */
const MAX_FRAGMENT_COLUMNS = 4200
/** Viewport at or below which the rung is capped at low regardless of the CPU.
 *  640 px is the phone/embedded class; `navigator` reports cores for phone SoCs
 *  (8-9) that mean nothing next to a desktop's, and a phone is the one place where
 *  fill rate and thermals both bite. */
const PHONE_VIEW_WIDTH = 640
/** Viewport to assume when the caller passes nonsense (0, NaN, negative). */
const DEFAULT_VIEW_WIDTH = 1280
/** `devicePixelRatio` is universally supported; if it were somehow missing, assume
 *  2 so the fill-rate correction is pessimistic rather than optimistic. */
const CONSERVATIVE_DPR = 2

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/** Rung indices, best first. A *lower* index is a *stronger* rung, so "step down
 *  the ladder" always means `Math.max(tier, ...)` — the direction is the single
 *  easiest thing to get backwards here, and getting it backwards silently hands a
 *  phone 18000 particles. */
export const TIER_HIGH = 0
export const TIER_MID = 1
export const TIER_LOW = 2
export const TIER_MINIMAL = 3

/**
 * The ladder, best rung first. Exported so tests (and the engine's diagnostics) can
 * assert the ordering invariant — every field is monotonically non-increasing as
 * the rung index grows — in one place instead of restating the numbers.
 */
export const QUALITY_TIERS: readonly QualityProfile[] = [
  // High: the §6 target — 1080p, desktop GPU, native-ish DPR. Antialiasing is on
  // only here: it multiplies the fragment cost of the starfield's quads and
  // fly-through shimmer is exactly what it fixes, but it is the first thing to
  // give up when the fill budget is tight (the comet's points gain little from it).
  {
    particleCount: BASE_PARTICLE_COUNT,
    maxDpr: MAX_DPR,
    antialias: true,
    starCount: BASE_STAR_COUNT,
    tailSampleCount: 96,
    iconCanvasSize: VENDOR_ICON_CANVAS_SIZE,
  },
  // Mid: integrated graphics, or a high-DPR laptop that would otherwise be pushing
  // 2x the fragments of the target configuration.
  {
    particleCount: ADAPTIVE_PARTICLE_COUNT,
    maxDpr: MID_DPR,
    antialias: false,
    starCount: MID_STAR_COUNT,
    tailSampleCount: MID_TAIL_SAMPLE_COUNT,
    iconCanvasSize: MID_ICON_CANVAS_SIZE,
  },
  // Low: old laptops, phones, 4K walls, anything reporting a small core count.
  {
    particleCount: MIN_PARTICLE_COUNT,
    maxDpr: LOW_DPR,
    antialias: false,
    starCount: LOW_STAR_COUNT,
    tailSampleCount: LOW_TAIL_SAMPLE_COUNT,
    iconCanvasSize: LOW_ICON_CANVAS_SIZE,
  },
  // Minimal: software rasteriser, or prefers-reduced-motion (§6 item 10). The
  // engine also drops the dolly and the travel sweep on this rung, so the numbers
  // here only have to keep the static glyph alive.
  {
    particleCount: SOFTWARE_PARTICLE_COUNT,
    maxDpr: LOW_DPR,
    antialias: false,
    starCount: SOFTWARE_STAR_COUNT,
    tailSampleCount: LOW_TAIL_SAMPLE_COUNT,
    iconCanvasSize: SOFTWARE_ICON_CANVAS_SIZE,
  },
]

// ---------------------------------------------------------------------------
// Profile assembly
// ---------------------------------------------------------------------------

/**
 * Build a profile from explicit knob values, filling whatever is not named from the
 * high rung.
 *
 * Overrides are sanitised rather than trusted: `Partial<QualityProfile>` permits
 * `{ particleCount: undefined }`, and a plain spread would let that undefined
 * clobber the default and reach the geometry allocation as a NaN length. So a
 * missing/NaN/infinite value is treated as "not specified", and a negative or zero
 * count is clamped instead of being handed downstream.
 */
export function createQualityProfile(
  overrides: Partial<QualityProfile> = {}
): QualityProfile {
  const base = QUALITY_TIERS[TIER_HIGH]
  const profile: QualityProfile = {
    particleCount: base.particleCount,
    maxDpr: base.maxDpr,
    antialias: base.antialias,
    starCount: base.starCount,
    tailSampleCount: base.tailSampleCount,
    iconCanvasSize: base.iconCanvasSize,
  }

  const count = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : fallback
  const ratio = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0.5, value as number) : fallback

  profile.particleCount = count(overrides.particleCount, profile.particleCount)
  profile.starCount = count(overrides.starCount, profile.starCount)
  profile.tailSampleCount = count(overrides.tailSampleCount, profile.tailSampleCount)
  profile.iconCanvasSize = count(overrides.iconCanvasSize, profile.iconCanvasSize)
  profile.maxDpr = ratio(overrides.maxDpr, profile.maxDpr)
  if (typeof overrides.antialias === 'boolean') profile.antialias = overrides.antialias

  return profile
}

// ---------------------------------------------------------------------------
// Device hints
// ---------------------------------------------------------------------------

export interface DeviceHints {
  /** `navigator.deviceMemory`, in GiB, or `null` when the browser will not say
   *  (Firefox and Safari never do). */
  memoryGb: number | null
  /** `navigator.hardwareConcurrency`, or `null`. */
  cores: number | null
  /** `window.devicePixelRatio`, or `null`. */
  dpr: number | null
  /** `(prefers-reduced-motion: reduce)`. */
  reducedMotion: boolean
  /** `true` for a software rasteriser, `false` for hardware, `null` when the probe
   *  could not tell (no WebGL anywhere, or no DOM at all). */
  softwareRenderer: boolean | null
}

/** Substrings that mean "the CPU is doing the rasterising".
 *
 *  `failIfMajorPerformanceCaveat` already catches most of these, but not every
 *  browser implements that flag honestly — and a GPU process that silently falls
 *  back to SwiftShader (`ANGLE (Google, Vulkan ... (SwiftShader Device ...))`) is
 *  common enough in VMs and on locked-down desktops to be worth naming directly.
 *  `Basic Render Driver` / `Microsoft Basic` are the Windows software fallback. */
const SOFTWARE_RENDERER_MARKERS =
  /swiftshader|llvmpipe|softpipe|swrast|basic render driver|microsoft basic|software (rasterizer|adapter|renderer)|mesa offscreen/i

/**
 * Read the GPU's own name to spot a software rasteriser. Returns `null` when the
 * answer cannot be determined — never throws, and never leaves an extra GL context
 * alive (browsers cap them, and leaking one here would cost the engine its own).
 *
 * Deliberately uncached: the probe costs a few milliseconds and is called once at
 * mount, whereas a module-level cache would make the answer depend on test order
 * and on whatever stubs happened to be installed on the first call.
 */
export function detectSoftwareRenderer(): boolean | null {
  if (typeof document === 'undefined') return null
  // Cheap environment gate first: if the globals are not even declared there is no
  // WebGL to ask, and jsdom in particular answers `getContext('webgl')` with a
  // "not implemented" complaint we would rather not provoke.
  if (
    typeof WebGLRenderingContext === 'undefined' &&
    typeof WebGL2RenderingContext === 'undefined'
  ) {
    return null
  }

  const base: WebGLContextAttributes = {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  }

  // A fresh canvas per attempt on purpose: asking one canvas for `webgl2` first and
  // falling back to `webgl` is allowed by the spec but has historically gone wrong
  // in the wild, and a 1x1 canvas costs nothing at probe time.
  const create = (attrs: WebGLContextAttributes) => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      return (
        (canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null) ??
        (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null)
      )
    } catch {
      // A driver that throws on context creation is a driver we cannot grade.
      return null
    }
  }

  // The honest question: "is there a non-software implementation of WebGL here?"
  // The spec says a context must not be returned if the only option would carry a
  // major performance caveat, which is exactly the software case.
  const strict = create({
    ...base,
    failIfMajorPerformanceCaveat: true,
    powerPreference: 'high-performance',
  })
  if (strict) {
    const name = readRendererName(strict)
    releaseContext(strict)
    return name.length > 0 ? SOFTWARE_RENDERER_MARKERS.test(name) : false
  }

  // No strict context. Either this browser has no WebGL at all, or software was the
  // only thing on offer; a permissive retry is what tells those two apart, and the
  // distinction matters — "no WebGL here" is the engine's problem to report, not a
  // weak GPU to be graded.
  const permissive = create({ ...base, powerPreference: 'low-power' })
  if (!permissive) return null
  releaseContext(permissive)
  return true
}

function readRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    if (debug) {
      const unmasked = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      if (typeof unmasked === 'string' && unmasked.length > 0) return unmasked
    }
    const masked = gl.getParameter(gl.RENDERER)
    return typeof masked === 'string' ? masked : ''
  } catch {
    // A driver that refuses `getParameter` should not take the whole probe down.
    return ''
  }
}

function releaseContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    /* extension unavailable: the backing store is dropped below instead */
  }
  try {
    const el = gl.canvas as unknown as HTMLCanvasElement | null
    if (el) {
      el.width = 0
      el.height = 0
    }
  } catch {
    /* nothing to do; the canvas is unreferenced and will be collected */
  }
}

/**
 * Read every hint the ladder uses, tolerating every one of them being absent.
 *
 * The only place a browser API is touched, which is why it is separate from the
 * decision that consumes it.
 */
export function readDeviceHints(): DeviceHints {
  const nav = typeof navigator === 'undefined' ? null : navigator

  // `deviceMemory` is not in the DOM lib yet (it is a Chromium-only extension), so
  // it has to come off a widened view of `navigator`.
  const memory = nav
    ? (nav as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined
  const memoryGb =
    typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? memory : null

  const cores = nav?.hardwareConcurrency
  const coreCount =
    typeof cores === 'number' && Number.isFinite(cores) && cores > 0 ? cores : null

  let dpr: number | null = null
  try {
    const value = typeof window === 'undefined' ? null : window.devicePixelRatio
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) dpr = value
  } catch {
    dpr = null
  }

  let reducedMotion = false
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    }
  } catch {
    // Some embedded WebViews throw on unknown media queries. Assuming "no
    // preference" is the safe reading: it keeps the animation, which is the
    // default the page is designed around.
    reducedMotion = false
  }

  return {
    memoryGb,
    cores: coreCount,
    dpr,
    reducedMotion,
    softwareRenderer: detectSoftwareRenderer(),
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Which rung the hints justify, before the viewport correction.
 *
 * Exported for testing: the ladder rules are the interesting part and they should
 * be assertable without building a fake `navigator`.
 */
export function tierForHints(hints: DeviceHints): number {
  // §6 item 10: reduced motion is not a performance question, it is the user's
  // stated preference — the lowest rung regardless of hardware.
  if (hints.reducedMotion) return TIER_MINIMAL
  // A software rasteriser is ~10-50x slower per fragment. Even a 32-core server VM
  // cannot blend its way out of that, so core count does not get a vote.
  if (hints.softwareRenderer === true) return TIER_MINIMAL

  const cores = hints.cores
  const memory = hints.memoryGb

  // No evidence at all is not a reason to gamble on the top rung: the middle is
  // indistinguishable from the top to the eye and ~40% cheaper.
  if (cores === null && memory === null) return TIER_MID

  // Each signal grades on its own, then the *weaker* one decides. The two disagree
  // in ways that matter — a Chromebook happily reports 8 cores next to 2 GiB — and
  // `deviceMemory` is the more trustworthy of the pair (a bucket Chromium derives
  // from the machine, not a core count that a Celeron and a Threadripper can share).
  const coresTier = cores === null ? TIER_HIGH : tierOfSignal(cores, 8, 4)
  const memoryTier = memory === null ? TIER_HIGH : tierOfSignal(memory, 8, 4)
  return Math.max(coresTier, memoryTier)
}

/** Two thresholds, three rungs: >= high is the top, >= mid the middle, else low. */
function tierOfSignal(value: number, high: number, mid: number): number {
  if (value >= high) return TIER_HIGH
  if (value >= mid) return TIER_MID
  return TIER_LOW
}

/**
 * Probe the running device and return the profile it can actually afford.
 *
 * `hints` exists so the ladder is testable without a DOM; production callers pass
 * only `viewWidth` and get the real probe.
 *
 * Call this once at mount, not per frame and not per resize: it may create and
 * throw away a throwaway WebGL context, which is a few milliseconds and, on the
 * first call only, is cached.
 */
export function probeQualityProfile(
  viewWidth: number,
  hints: DeviceHints = readDeviceHints()
): QualityProfile {
  const width =
    Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : DEFAULT_VIEW_WIDTH

  let tier = tierForHints(hints)

  // Viewport corrections. Both only ever move *down* the ladder, so a caller cannot
  // get a better rung by lying about the screen size. Note the direction: a lower
  // tier index means a *stronger* rung, so "weaker" is `Math.max`, not `Math.min`.
  if (width <= PHONE_VIEW_WIDTH) tier = Math.max(tier, TIER_LOW)

  // Fill-rate correction, iterated because the DPR cap shrinks with the rung: a
  // 4K wall at DPR 2 first drops to the mid rung (cap 1.25 -> 4800 columns), then
  // to the low rung (cap 1.0 -> 3840 columns) and stops there. Iterating rather
  // than solving in closed form keeps the loop honest about the caps actually
  // being applied, at four comparisons' worth of cost.
  const deviceDpr = hints.dpr === null ? CONSERVATIVE_DPR : hints.dpr
  let guard = 0
  while (tier < TIER_LOW && guard++ < QUALITY_TIERS.length) {
    const columns = width * Math.min(deviceDpr, QUALITY_TIERS[tier].maxDpr)
    if (columns <= MAX_FRAGMENT_COLUMNS) break
    tier += 1
  }

  return { ...QUALITY_TIERS[tier] }
}
