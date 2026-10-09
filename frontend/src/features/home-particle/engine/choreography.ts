/**
 * LANE L2 — comet choreography.
 *
 * One beat per brand, matching HOME-PARTICLE-DESIGN.md §4 and §1 (R3-R7):
 *
 *   travel   6.5 s  the comet cruises one S-leg, extreme to extreme
 *   gather   1.4 s  the comet lets go and takes the glyph's shape
 *   hold     3.0 s  [user] the glyph keeps its shape while particles flow inside it
 *   scatter  1.1 s  the glyph dissipates and the comet re-forms
 *   ---------------------------------------------------------------------------
 *   beat    12.0 s  one brand; a 28-brand roster is 336 s ≈ 5.6 min per lap
 *
 * Pure and DOM-free: no three.js, no timers, no `performance.now()`. `update()`
 * consumes elapsed seconds and the caller's frame loop owns the cadence, which is
 * what makes the clock framerate independent (§6 item 3).
 */
import type {
  Choreography,
  ChoreographyOptions,
  ChoreographyState,
  CometPhase,
} from './types'
import {
  GATHER_SECONDS,
  HOLD_SECONDS,
  LEG_SECONDS,
  SCATTER_SECONDS,
} from './constants'

/** A point in subject space (x right, y up, z toward the camera). */
export interface Point3 {
  x: number
  y: number
  z: number
}

/** The phases of a beat, in order. The index is also the order in the beat. */
const PHASES: readonly CometPhase[] = ['travel', 'gather', 'hold', 'scatter'] as const

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  // Written with `!(value > 0)` so a NaN argument lands on 0 instead of
  // propagating a NaN through every downstream position.
  if (!(value > 0)) return 0
  return value < 1 ? value : 1
}

/**
 * Ken Perlin's smootherstep: 0..1, C2-continuous, with zero first *and* second
 * derivative at both ends.
 *
 * `gather` and `scatter` blend the comet's shape into the glyph's and back. The
 * classic smoothstep already matches its own slope at the ends, but not its
 * curvature; on a 18000-particle cloud the leftover curvature discontinuity shows
 * up as a one-frame "kick" in the tail right at the handover, which is exactly
 * where the eye is watching for the shape to lock in. Smootherstep removes it for
 * the price of one extra multiply.
 */
export function smootherStep(t: number): number {
  const c = clamp01(t)
  return c * c * c * (c * (c * 6 - 15) + 10)
}

/**
 * The extreme leg `legIndex` departs from.
 *
 * Parity, not the value of `legIndex`, flips the sweep, so the comet goes right,
 * then left, then right ([user] "不断S形左右来回移动"). Without the flip every leg
 * would run the same way and the two humps of the S would stack into one arc
 * instead of mirroring.
 *
 * The `+2) % 2` normalisation keeps parity correct for negative legs, which is how
 * `sampleTrail()` reaches back before the current beat.
 */
export function legFromX(legIndex: number, amplitudeX: number): number {
  return ((legIndex % 2) + 2) % 2 === 0 ? -amplitudeX : amplitudeX
}

// ---------------------------------------------------------------------------
// Head path
// ---------------------------------------------------------------------------

/**
 * Comet head at `phaseProgress` through `phase` of leg `legIndex`.
 *
 * Only `travel` moves. The other three phases pin the head to the extreme the leg
 * arrived at, so the glyph forms at the route's leftmost or rightmost point
 * ([user] "在达到路线的最左侧和最右侧时聚集成目标3D图案") and no phase change can
 * teleport the head.
 *
 * `out` is caller-owned because §6 item 2 forbids per-frame allocation: this runs
 * once per frame and once per trail sample.
 */
export function sampleHeadPosition(
  legIndex: number,
  phase: CometPhase,
  phaseProgress: number,
  options: ChoreographyOptions,
  out: Point3 = { x: 0, y: 0, z: 0 }
): Point3 {
  const amplitudeX = finiteOr(options.amplitudeX, 0)
  const fromX = legFromX(legIndex, amplitudeX)
  const toX = -fromX

  if (phase !== 'travel') {
    // Arrived. gather/hold/scatter change the *shape* of the cloud, never where
    // its centre sits — the glyph is built around this exact point.
    out.x = toX
    out.y = 0
    out.z = 0
    return out
  }

  // Lateral easing: (1 - cos(pi*p)) / 2 is 0 at p=0, 1 at p=1, and its slope
  // vanishes at both ends. That is the "到达" feel the spec asks for: the comet
  // decelerates into the extreme and accelerates back out, giving the glyph a
  // beat of near-stillness to assemble in rather than slamming it together at
  // full speed. It also means `headX` is monotone along the leg, which is what
  // `sampleTrail()` relies on to lay the tail out without self-crossing.
  const eased = (1 - Math.cos(Math.PI * clamp01(phaseProgress))) / 2

  out.x = fromX + (toX - fromX) * eased

  // The S itself. Vertical and depth run at the same frequency, a quarter period
  // apart — that quadrature is what makes the sweep three-dimensional:
  //   y ∝ sin(2π·e)      peaks at the quarter points
  //   z ∝ 1 - cos(2π·e)  deepest at mid-leg, back on the glyph plane at both ends
  // Two in-phase sines would give z = k·y, i.e. a curve lying in a plane, and the
  // sweep would read as a flat wiggle. In quadrature the (y,z) projection traces a
  // closed loop while x advances monotonically: a helix, a genuine S in space.
  // Both ends still land on (0, 0), so `travel` hands over to `gather` at exactly
  // the point the glyph is drawn around — no positional pop at the seam.
  const dir = ((legIndex % 2) + 2) % 2 === 0 ? 1 : -1
  const turn = 2 * Math.PI * eased
  out.y = finiteOr(options.swayY, 0) * dir * Math.sin(turn)
  out.z = -(finiteOr(options.swayZ, 0) / 2) * (1 - Math.cos(turn))

  return out
}

// ---------------------------------------------------------------------------
// Clock plumbing
// ---------------------------------------------------------------------------

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * A caller-supplied duration must be a positive finite number of seconds. A bad
 * value falls back to the frozen constant rather than to NaN: one NaN would poison
 * every comparison in the clock and blank the canvas, which is far worse than
 * quietly ignoring a nonsense option.
 */
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Cumulative phase boundaries of one beat, in seconds since the beat started. */
interface Timeline {
  leg: number
  gather: number
  hold: number
  scatter: number
  /** End of `gather` == start of `hold`. */
  gatherEnd: number
  /** End of `hold` == start of `scatter`. */
  holdEnd: number
  /** Total beat length: LEG + GATHER + HOLD + SCATTER. */
  cycle: number
}

function buildTimeline(options: ChoreographyOptions): Timeline {
  const leg = positiveOr(options.legSeconds, LEG_SECONDS)
  const gather = positiveOr(options.gatherSeconds, GATHER_SECONDS)
  const hold = positiveOr(options.holdSeconds, HOLD_SECONDS)
  const scatter = positiveOr(options.scatterSeconds, SCATTER_SECONDS)
  const gatherEnd = leg + gather
  const holdEnd = gatherEnd + hold
  return {
    leg,
    gather,
    hold,
    scatter,
    gatherEnd,
    holdEnd,
    cycle: holdEnd + scatter,
  }
}

function phaseIndexAt(time: Timeline, clock: number): number {
  if (clock < time.leg) return 0
  if (clock < time.gatherEnd) return 1
  if (clock < time.holdEnd) return 2
  return 3
}

function phaseProgressAt(time: Timeline, clock: number, index: number): number {
  switch (index) {
    case 0:
      return clamp01(clock / time.leg)
    case 1:
      return clamp01((clock - time.leg) / time.gather)
    case 2:
      return clamp01((clock - time.gatherEnd) / time.hold)
    default:
      return clamp01((clock - time.holdEnd) / time.scatter)
  }
}

function wrapIndex(value: number, modulo: number): number {
  const m = Math.max(1, Math.floor(finiteOr(modulo, 1)))
  const r = value % m
  return r < 0 ? r + m : r
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The phase clock for the comet.
 *
 * Everything hangs off one accumulator, `beatElapsed`: the seconds since the
 * current beat began. Phase and progress are *derived* from it against the
 * precomputed cumulative boundaries, so an update costs one rounding step instead
 * of one per phase transition — per-phase counters are what usually make clocks
 * like this drift by microseconds per beat, and this page is expected to stay open
 * for hours across 336 one-beat laps.
 *
 * `brandCount` comes from the caller's roster; nothing here assumes 28.
 */
export function createChoreography(options: ChoreographyOptions): Choreography {
  const brandCount = Math.max(1, Math.floor(finiteOr(options.brandCount, 1)))
  const time = buildTimeline(options)
  // Sanitised once so `legFromX` and `sampleHeadPosition` cannot disagree about the
  // amplitude. If a NaN reached only one of them the state would report a NaN
  // `fromX` while the head still moved somewhere — and the render lane would read a
  // NaN direction and blank the frame.
  const safe: ChoreographyOptions = {
    ...options,
    brandCount,
    amplitudeX: finiteOr(options.amplitudeX, 0),
    swayY: finiteOr(options.swayY, 0),
    swayZ: finiteOr(options.swayZ, 0),
  }

  let beatElapsed = 0
  let legIndex = 0
  let brandIndex = 0

  const state: ChoreographyState = {
    phase: 'travel',
    phaseProgress: 0,
    legIndex,
    brandIndex,
    fromX: 0,
    toX: 0,
    headX: 0,
    headY: 0,
    headZ: 0,
  }

  // Scratch target for `sampleHeadPosition`, reused every frame (§6 item 2). It
  // has to be a separate object rather than `state` itself: that carries
  // `headX/headY/headZ`, while the sampler writes `x/y/z`.
  const head: Point3 = { x: 0, y: 0, z: 0 }

  /** Fold `beats` finished beats into the indices in O(1), so a huge catch-up step
   *  (a tab that was asleep for six hours) costs the same as a normal frame. */
  function advanceBeats(beats: number): void {
    legIndex += beats
    brandIndex = wrapIndex(brandIndex + beats, brandCount)
  }

  /** Re-derive `state` from `beatElapsed`. Called at the end of every `update()`. */
  function writeState(): void {
    const index = phaseIndexAt(time, beatElapsed)
    const fromX = legFromX(legIndex, safe.amplitudeX)
    state.phase = PHASES[index]
    state.phaseProgress = phaseProgressAt(time, beatElapsed, index)
    state.legIndex = legIndex
    state.brandIndex = brandIndex
    // `fromX`/`toX` describe the current leg, so they stay fixed for the whole
    // beat — including `hold`, when the glyph sits on `toX` but the engine still
    // wants to know which way the next leg will run.
    state.fromX = fromX
    state.toX = -fromX
    sampleHeadPosition(legIndex, state.phase, state.phaseProgress, safe, head)
    state.headX = head.x
    state.headY = head.y
    state.headZ = head.z
  }

  writeState()

  return {
    update(deltaSeconds: number): void {
      // A negative or NaN delta happens when a caller feeds a clamped clock.
      // Ignoring it keeps the phase machine monotone; `frameStep` normalisation is
      // the render lane's business, not the clock's.
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return

      const total = beatElapsed + deltaSeconds

      if (total >= time.cycle) {
        // Arithmetic wrap instead of a subtraction loop: a six-hour catch-up step
        // costs three divisions rather than ~1800 iterations, and the leftover
        // carries the same single rounding the accumulate-and-compare path has.
        const beats = Math.floor(total / time.cycle)
        beatElapsed = total - beats * time.cycle
        advanceBeats(beats)
      } else {
        beatElapsed = total
      }

      writeState()
    },

    get state(): ChoreographyState {
      // The same object every frame — zero per-frame allocation (§6 item 2).
      // Callers treat it as read-only; the engine copies out what it needs.
      return state
    },

    /**
     * Where the head was `delaySeconds` ago.
     *
     * The tail asks this for every particle every frame, and it needs no ring
     * buffer: the head's path is already a closed-form function of
     * (legIndex, phase, progress), so the past is the same function evaluated at an
     * earlier clock reading. Memory cost: zero.
     *
     * Cross-phase replay falls out of that for free. One frame into `gather`, the
     * clock minus TAIL_SECONDS still lands inside `travel`, so the comet's tail is
     * genuinely still stretched back along the S-leg rather than snapping to the
     * glyph. From `hold` onward the replayed instant is itself a stationary phase,
     * so the tail converges onto the glyph on its own. No special cases, and no
     * seam to hide.
     */
    sampleTrail(delaySeconds: number, out: Point3): void {
      const delay = Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 0
      let leg = legIndex
      let clock = beatElapsed - delay

      if (clock < 0) {
        // Normally at most one beat back (delay <= TAIL_SECONDS < cycle), but the
        // arithmetic form stays correct for arbitrarily long delays, which matters
        // because the engine is free to pass its own tail length.
        const beatsBack = Math.ceil(-clock / time.cycle)
        clock += beatsBack * time.cycle
        leg -= beatsBack
      }

      const index = phaseIndexAt(time, clock)
      sampleHeadPosition(
        leg,
        PHASES[index],
        phaseProgressAt(time, clock, index),
        options,
        out
      )
    },

    /**
     * Move to the next brand without waiting out the current beat — the engine uses
     * it when the glyph it needs is not the one the roster order would hand it. The
     * phase clock is untouched, so a manual advance never desynchronises the beat.
     */
    nextBrand(): void {
      brandIndex = wrapIndex(brandIndex + 1, brandCount)
      state.brandIndex = brandIndex
    },
  }
}
