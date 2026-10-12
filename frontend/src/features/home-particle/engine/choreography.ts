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

/**
 * The per-particle blend weight between the comet shape and the glyph shape.
 *
 * `staggeredGlyphMix(phase, progress, seed, 0)` is exactly this function, and a
 * test in `__tests__/choreography.spec.ts` pins that identity against the engine's
 * own `glyphMixFor`. The duplication is deliberate and the test is what makes it
 * safe: `ParticleEngine.ts` is another lane's file, this one is mine, and the only
 * way to keep two copies of a curve honest is to assert they agree rather than to
 * assume it.
 */
function baseGlyphMix(phase: CometPhase, progress: number): number {
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

/**
 * How much of a transition's length one particle may be held back, as a share of
 * the phase.
 *
 * Derivation. Without a stagger every particle reads the same `progress`, so the
 * whole cloud morphs on one shared curve and the eye reads a single rigid
 * deformation rather than a gathering swarm. Holding each particle back by its own
 * share of the phase turns that one curve into a spray of parallel curves, which
 * is what gives the transition its "some arrive early, some late" texture.
 *
 * 0.28 is the largest value that still leaves the glyph exact by the end of the
 * phase. The latest-starting particle (its stagger roll lands on 1) only begins
 * moving at `progress = 0.28`, so it has the remaining 72% of the phase to cover
 * the whole distance. That is the trade the number buys —
 *
 *   gather   1.4 s -> the last particle gets 1.008 s of real travel
 *   scatter  1.1 s -> the last particle gets 0.792 s
 *
 * Push it towards 0.5 and the tail of the cloud is still visibly in flight when
 * `hold` begins, which is the one thing the phase clock cannot absorb: the glyph
 * would still be settling through the 3 s it is supposed to sit perfectly still.
 * Push it towards 0 and the stagger collapses back into the rigid block it was
 * meant to break up.
 *
 * Note this spreads the cloud; it does not delay the transition. The earliest
 * particle (`roll = 0`) finishes its travel at `progress = 1 - GLYPH_STAGGER ==
 * 0.72` and the latest (`roll = 1`) starts there, and both ends still land exactly
 * on the phase endpoint at `progress = 1`, so the beat's length is untouched and
 * the glyph is fully assembled for the last 28% of the gather. That early settle is
 * a bonus rather than a cost: it hands the 3 s hold a shape that is already still.
 */
export const GLYPH_STAGGER = 0.28

/**
 * Salt for the stagger roll, matching the constants `ParticleEngine.hash01()`
 * feeds itself.
 *
 * The stagger offset must be independent of the particle's position along the tail
 * (`tailT`), which is a golden-ratio low-discrepancy sequence. Deriving the offset
 * from `frac(i * k * PHI)` would make it a deterministic function of `tailT` — the
 * exact mistake the engine's own `hash01` docstring records, where every tail
 * attribute collapsed onto an ordered helix. An avalanche hash gives a roll that
 * is independent of the position roll and of every other per-particle attribute,
 * so where a particle sits along the comet says nothing about when it leaves it.
 */
export const GLYPH_STAGGER_SALT = 0x27d4eb2f

/** Keeps `1 - spread` away from zero for any caller-supplied spread. */
const MAX_GLYPH_STAGGER = 0.98

/**
 * A decorrelated 0..1 roll from an integer seed, bit-for-bit the same avalanche
 * as `ParticleEngine.hash01` so a seed and a particle index behave identically on
 * both sides of the lane boundary. `Math.imul` keeps every step in 32-bit integer
 * arithmetic, which is what makes the result reproducible across engines.
 */
export function staggerRoll(seed: number, salt: number = GLYPH_STAGGER_SALT): number {
  const key = Number.isFinite(seed) ? Math.floor(seed) : 0
  let h = Math.imul(key ^ salt, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** The spread, sanitised: finite, in [0, MAX_GLYPH_STAGGER]. */
function staggerSpread(spread: number): number {
  if (!Number.isFinite(spread)) return GLYPH_STAGGER
  return Math.min(Math.max(spread, 0), MAX_GLYPH_STAGGER)
}

/**
 * The per-particle blend weight between the comet shape and the glyph shape.
 *
 * Same contract as `glyphMixFor()` — 0 is a pure comet, 1 is the settled glyph —
 * but each particle runs the curve on its own clock:
 *
 *   t = clamp((progress - spread * roll) / (1 - spread), 0, 1)
 *   mix = the phase's own curve evaluated at t
 *
 * Three properties are load-bearing, and each one is the reason for a term above:
 *
 * 1. **The endpoints are exact, for every seed.** At `progress <= 0`, `t` clamps to
 *    0; at `progress >= 1`, `t` is `(1 - spread*roll) / (1 - spread) >= 1`, which
 *    also clamps to 1. Every particle therefore reads exactly the phase's own
 *    endpoint — gather 0 -> 1, scatter 1 -> 0, hold 1, travel 0. Without that the
 *    glyph would be assembled out of particles that never quite finished arriving,
 *    and the 3 s hold would show a shape still creeping into place. The division by
 *    `(1 - spread)` is what buys it: the latest roll is normalised so it still
 *    lands on 1 at the same `progress` as every other particle.
 *
 * 2. **Monotone in the phase's own direction.** `t` is non-decreasing in
 *    `progress`, and so is every curve applied to it, so a gather never un-gathers
 *    and a scatter never re-forms. A particle that has started towards the glyph
 *    cannot change its mind and go back — which is what a per-particle wobble looks
 *    like, and it reads as the cloud shivering rather than assembling.
 *
 * 3. **Dispersed for every interior progress.** `roll` is a per-seed uniform, so at
 *    a fixed `progress` in `(0, 1)` the particles take a band of `t` values
 *    `spread / (1 - spread)` wide — 0.39 of the phase at the shipped
 *    `GLYPH_STAGGER`, measured as a 0.66-wide band of mix values at the midpoint
 *    and 0.20 as a standard deviation across 512 seeds. That band *is* the
 *    stagger, and it narrows to zero at both ends, which is property 1 seen from
 *    the other side.
 *
 *    The band straddles the plain curve rather than trailing it. `roll = 0` warps
 *    `progress` *up* by `1 / (1 - spread)` — a particle with the lowest roll
 *    reaches the glyph at `progress = 0.72` instead of at 1 — while `roll = 1`
 *    warps it down and does not start moving until `progress = 0.28`. Both are
 *    wanted: a stagger where every particle merely lagged would pull the cloud's
 *    centre of mass behind the phase's own ramp and read as the whole transition
 *    running late, rather than as the cloud separating into early and late arrivals
 *    around a shared midpoint. Measured on 512 seeds, at least one particle leads
 *    the plain curve and at least one trails it at every sample strictly inside the
 *    phase.
 *
 * `spread = 0` reduces `t` to `progress` and the function to the plain curve, so
 * the stagger can be switched off without touching a call site.
 *
 * There is deliberately no overshoot in the curve. A little past-the-target
 * overshoot would make the arrival feel springy, but it breaks property 2: a
 * particle that overshoots has reversed direction, and across 18000 of them that
 * reversal reads as a shudder at the handover — precisely the moment the eye is
 * watching the shape lock in.
 */
export function staggeredGlyphMix(
  phase: CometPhase,
  progress: number,
  seed: number,
  spread: number = GLYPH_STAGGER
): number {
  return staggeredGlyphMixFromRoll(phase, progress, staggerRoll(seed), spread)
}

/**
 * The same blend, for a caller that has already baked its rolls.
 *
 * The engine evaluates this once per particle per frame, and a particle's roll
 * never changes, so hashing it 18000 times a frame to get a constant would be
 * pure waste. `staggerRoll(i)` is meant to be baked once into a per-particle
 * buffer — the same treatment the engine already gives `tailAngle`, `tailRadius`
 * and `tailSpin` in `createEngineScratch` — and this entry point is what it reads
 * back. It is also the form the tests exercise, since it isolates the staggering
 * maths from the hash.
 */
export function staggeredGlyphMixFromRoll(
  phase: CometPhase,
  progress: number,
  roll: number,
  spread: number = GLYPH_STAGGER
): number {
  // The two constant phases have nothing to stagger: one end of the beat is pure
  // comet and the other is the settled glyph, and every particle is already on the
  // same side of both. Returning early keeps them bit-exact.
  if (phase === 'travel') return 0
  if (phase === 'hold') return 1

  const amount = staggerSpread(spread)
  // A roll outside 0..1 would let a particle start before the phase does.
  const r = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1) : 0
  const p = clamp01(progress)

  // `1 - amount` is at least 0.02 after the clamp, so this cannot divide by zero.
  const warped = clamp01((p - amount * r) / (1 - amount))

  // The base curve carries the per-phase shape and direction (gather rises
  // 0 -> 1, scatter falls 1 -> 0), so the stagger only ever warps the clock and
  // never second-guesses the shape maths.
  return baseGlyphMix(phase, warped)
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
        // `safe`, not the raw `options`: this is the same object `writeState` samples, so
        // a runtime `setSwayY` moves the head and its trail together. Passing the raw
        // options here was equivalent while nothing mutated them (both paths sanitise),
        // but once the sway is retuned on resize the two would disagree and the tail
        // would replay a path the head is no longer on.
        safe,
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

    /**
     * Retune the vertical sway (see the interface for why only this one).
     *
     * `writeState()` is called immediately so `state.headY` reflects the new sway on the
     * same frame. Without it the state would keep the old amplitude until the next
     * `update()`, and the engine seeds the opening glyph and reads `state` before the
     * first update — so a resize during boot would put the glyph on the old curve.
     *
     * A non-finite input is ignored rather than sanitised to 0: a 0 sway is a legitimate
     * setting (a flat S), so silently clamping a NaN to it would turn a caller's bug
     * into a plausible-looking layout.
     */
    setSwayY(next: number): void {
      if (!Number.isFinite(next)) return
      safe.swayY = next
      writeState()
    },
  }
}
