/**
 * Lane L2 — the per-particle stagger on the comet <-> glyph transition.
 *
 * Why this is its own file rather than a describe block in `choreography.spec.ts`:
 * that file is about the *clock* (phase boundaries, drift, framerate independence)
 * and this one is about a *shape blend*. They share an import and nothing else, and
 * the stagger has three properties that each deserve to be pinned separately —
 * endpoint convergence, monotonicity, and actual dispersal. A regression in any one
 * of them is invisible in the other two, so lumping them together would let a
 * passing suite hide a broken transition.
 *
 * The properties, and what breaks without each:
 *
 *   endpoints   the glyph must be *exactly* the glyph at the end of `gather`, or
 *               the 3 s hold is a picture of particles still arriving.
 *   monotone    a particle that un-gathers reads as the whole cloud shivering.
 *   dispersed   without it, the stagger does nothing and we are back to a rigid
 *               block morphing — the thing the user asked to have fixed.
 */
import { describe, expect, it } from 'vitest'
import {
  GLYPH_STAGGER,
  GLYPH_STAGGER_SALT,
  staggeredGlyphMix,
  staggeredGlyphMixFromRoll,
  staggerRoll,
} from '../choreography'
import { glyphMixFor } from '../ParticleEngine'
import type { CometPhase } from '../types'

/** The two phases that actually move particles between the two shapes. */
const TRANSITIONS: CometPhase[] = ['gather', 'scatter']
const PHASES: CometPhase[] = ['travel', 'gather', 'hold', 'scatter']

/** 512 seeds, as the brief asks — enough for a stable standard deviation. */
const SEED_COUNT = 512
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i)

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function stdDev(values: number[]): number {
  const m = mean(values)
  return Math.sqrt(mean(values.map((v) => (v - m) * (v - m))))
}

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

describe('staggerRoll', () => {
  it('is uniform-ish over 512 seeds and independent of the index', () => {
    const rolls = SEEDS.map((seed) => staggerRoll(seed))
    for (const roll of rolls) {
      expect(Number.isFinite(roll)).toBe(true)
      expect(roll).toBeGreaterThanOrEqual(0)
      expect(roll).toBeLessThan(1)
    }
    // A hash whose mean drifts far from 0.5 would bias every particle towards one
    // end of the stagger window, i.e. towards moving together — the thing the
    // stagger exists to prevent.
    expect(Math.abs(mean(rolls) - 0.5)).toBeLessThan(0.05)
    // And it must actually be spread, not clustered on a few values.
    expect(stdDev(rolls)).toBeGreaterThan(0.25)
  })

  it('does not correlate with the particle index as a sequence', () => {
    // The failure mode `hash01`'s own docstring records: an offset derived from a
    // golden-ratio term becomes a function of the position roll, and the cloud
    // orders itself. A monotone-ish roll shows up as a large lag-1 correlation.
    const rolls = SEEDS.map((seed) => staggerRoll(seed))
    const m = mean(rolls)
    let numerator = 0
    let denominator = 0
    for (let i = 1; i < rolls.length; i++) numerator += (rolls[i] - m) * (rolls[i - 1] - m)
    for (const roll of rolls) denominator += (roll - m) * (roll - m)
    const lag1 = numerator / denominator
    expect(Math.abs(lag1), 'roll is correlated with the previous index').toBeLessThan(0.15)
  })

  it('gives distinct salts distinct rolls and tolerates nonsense input', () => {
    expect(staggerRoll(7, GLYPH_STAGGER_SALT)).not.toBe(staggerRoll(7, 0x12345678))
    expect(Number.isFinite(staggerRoll(Number.NaN))).toBe(true)
    expect(Number.isFinite(staggerRoll(Number.POSITIVE_INFINITY))).toBe(true)
    expect(Number.isFinite(staggerRoll(-3.7))).toBe(true)
    expect(staggerRoll(4)).toBe(staggerRoll(4.9))
  })
})

// ---------------------------------------------------------------------------
// Property 1 — the endpoints are exact, for every seed
// ---------------------------------------------------------------------------

describe('staggeredGlyphMix endpoints', () => {
  it('is exactly 0 at or before progress 0 of a gather, for all 512 seeds', () => {
    for (const seed of SEEDS) {
      expect(staggeredGlyphMix('gather', 0, seed)).toBe(0)
      expect(staggeredGlyphMix('gather', -0.5, seed)).toBe(0)
      expect(staggeredGlyphMix('gather', Number.NEGATIVE_INFINITY, seed)).toBe(0)
    }
  })

  it('is exactly 1 at or after progress 1 of a gather, for all 512 seeds', () => {
    for (const seed of SEEDS) {
      expect(staggeredGlyphMix('gather', 1, seed)).toBe(1)
      expect(staggeredGlyphMix('gather', 1.5, seed)).toBe(1)
      expect(staggeredGlyphMix('gather', Number.POSITIVE_INFINITY, seed)).toBe(1)
    }
  })

  it('mirrors those endpoints for a scatter, for all 512 seeds', () => {
    // The scatter runs the other way: 1 is the settled glyph leaving, 0 is the
    // comet re-formed. Getting this backwards would make the shape snap.
    for (const seed of SEEDS) {
      expect(staggeredGlyphMix('scatter', 0, seed)).toBe(1)
      expect(staggeredGlyphMix('scatter', -0.5, seed)).toBe(1)
      expect(staggeredGlyphMix('scatter', 1, seed)).toBe(0)
      expect(staggeredGlyphMix('scatter', 5, seed)).toBe(0)
    }
  })

  it('is constant on the two phases that do not blend', () => {
    for (const seed of SEEDS) {
      for (const progress of [0, 0.25, 0.5, 0.999, 1]) {
        expect(staggeredGlyphMix('travel', progress, seed)).toBe(0)
        expect(staggeredGlyphMix('hold', progress, seed)).toBe(1)
      }
    }
  })

  it('hands over to the next phase without a pop, at every seed', () => {
    // gather(1) == hold(0), hold(1) == scatter(0), scatter(1) == travel(0). The
    // unstaggered suite asserts this for the plain curve; the stagger must not
    // reintroduce a seam, since a particle still in flight at a boundary would
    // make the handover depend on its seed.
    for (const phase of PHASES) {
      const next = PHASES[(PHASES.indexOf(phase) + 1) % PHASES.length]
      for (const seed of SEEDS) {
        expect(staggeredGlyphMix(phase, 1, seed)).toBeCloseTo(
          staggeredGlyphMix(next, 0, seed),
          12
        )
      }
    }
  })

  it('keeps the whole blend inside [0, 1] everywhere', () => {
    for (const phase of PHASES) {
      for (let step = 0; step <= 100; step++) {
        for (const seed of [0, 1, 17, 255, 511]) {
          const mix = staggeredGlyphMix(phase, step / 100, seed)
          expect(mix).toBeGreaterThanOrEqual(0)
          expect(mix).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 2 — monotone in the phase's own direction
// ---------------------------------------------------------------------------

describe('staggeredGlyphMix monotonicity', () => {
  it('never decreases across a gather, for all 512 seeds, over 200 samples', () => {
    const SAMPLES = 200
    for (const seed of SEEDS) {
      let previous = staggeredGlyphMix('gather', 0, seed)
      for (let step = 1; step <= SAMPLES; step++) {
        const mix = staggeredGlyphMix('gather', step / SAMPLES, seed)
        expect(
          mix,
          `seed ${seed} went backwards at progress ${step / SAMPLES}`
        ).toBeGreaterThanOrEqual(previous)
        previous = mix
      }
      expect(previous).toBe(1)
    }
  })

  it('never increases across a scatter, for all 512 seeds, over 200 samples', () => {
    const SAMPLES = 200
    for (const seed of SEEDS) {
      let previous = staggeredGlyphMix('scatter', 0, seed)
      for (let step = 1; step <= SAMPLES; step++) {
        const mix = staggeredGlyphMix('scatter', step / SAMPLES, seed)
        expect(
          mix,
          `seed ${seed} went forwards at progress ${step / SAMPLES}`
        ).toBeLessThanOrEqual(previous)
        previous = mix
      }
      expect(previous).toBe(0)
    }
  })

  it('stays monotone with a coarser frame step, since the engine samples on frames', () => {
    // A 60 Hz frame inside a 1.4 s gather steps ~0.012 in progress. Stepping the
    // whole transition in 20 jumps is far coarser than any real frame and must
    // still never reverse.
    for (const seed of [0, 3, 99, 256, 511]) {
      for (const phase of TRANSITIONS) {
        const direction = phase === 'gather' ? 1 : -1
        let previous = staggeredGlyphMix(phase, 0, seed)
        for (let step = 1; step <= 20; step++) {
          const mix = staggeredGlyphMix(phase, step / 20, seed)
          expect((mix - previous) * direction).toBeGreaterThanOrEqual(0)
          previous = mix
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 3 — the stagger actually disperses the particles
// ---------------------------------------------------------------------------

describe('staggeredGlyphMix dispersal', () => {
  it('gives seeds different mix values at the same progress, for every interior sample', () => {
    // Two different floors, because the band legitimately closes at both ends (that
    // is the endpoint property) and a single threshold would be either vacuous in
    // the middle or false near the edges:
    //   - anywhere strictly inside the phase there must be *some* dispersion;
    //   - through the middle, where the eye actually watches the transition, the
    //     dispersion must be large and the seeds must land on many distinct values
    //     rather than on a handful of clamped ones.
    //
    // The middle window is the quarter-to-three-quarter span rather than the whole
    // interior: measured across 512 seeds the standard deviation runs
    // 0.064 -> 0.196 -> 0.070 over [0.25, 0.75], and it falls off steeply outside
    // that (0.035 at 0.2, 0.039 at 0.8), so a 0.05 floor is a real statement about
    // the middle and a false one at the shoulders.
    for (const phase of TRANSITIONS) {
      for (let step = 1; step < 40; step++) {
        const progress = step / 40
        const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, progress, seed))
        expect(
          Math.max(...mixes) - Math.min(...mixes),
          `${phase} at progress ${progress} did not stagger`
        ).toBeGreaterThan(0)

        if (progress >= 0.25 && progress <= 0.75) {
          expect(stdDev(mixes), `${phase} at ${progress} lost its stagger`).toBeGreaterThan(
            0.05
          )
          expect(
            new Set(mixes).size,
            `${phase} at ${progress} collapsed onto too few values`
          ).toBeGreaterThan(SEED_COUNT / 4)
        }
      }
    }
  })

  it('keeps a wide band through the middle half of the phase', () => {
    // Measured: sd peaks at ~0.196 around progress 0.5 and is still ~0.10 at the
    // quarter points. These bounds are deliberately looser than the measurement so
    // the test pins the *shape* of the curve, not its last decimal.
    for (const phase of TRANSITIONS) {
      for (const progress of [0.3, 0.4, 0.5, 0.6, 0.7]) {
        const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, progress, seed))
        expect(
          stdDev(mixes),
          `${phase} at ${progress} lost its stagger`
        ).toBeGreaterThan(0.05)
      }
    }
    // And the peak is the midpoint, not an end.
    const middle = stdDev(SEEDS.map((seed) => staggeredGlyphMix('gather', 0.5, seed)))
    const quarter = stdDev(SEEDS.map((seed) => staggeredGlyphMix('gather', 0.25, seed)))
    expect(middle).toBeGreaterThan(quarter)
  })

  it('narrows the band monotonically towards both ends', () => {
    // The band closing is what makes the glyph crisp: dispersion has to fall away
    // towards 0 and 1, not stay wide or widen.
    for (const phase of TRANSITIONS) {
      const band = (progress: number) => {
        const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, progress, seed))
        return Math.max(...mixes) - Math.min(...mixes)
      }
      const rising = [0.02, 0.15, 0.3, 0.5].map(band)
      for (let i = 1; i < rising.length; i++) {
        expect(rising[i]).toBeGreaterThan(rising[i - 1])
      }
      const falling = [0.5, 0.7, 0.85, 0.98].map(band)
      for (let i = 1; i < falling.length; i++) {
        expect(falling[i]).toBeLessThan(falling[i - 1])
      }
    }
  })

  it('spreads the cloud across most of the staggered band at mid-transition', () => {
    // At progress 0.5 the slowest particle has not started and the fastest is past
    // halfway. The gap between the extremes is what reads as the swarm: measured at
    // 0.66, asserted here with room for the exact seed set.
    for (const phase of TRANSITIONS) {
      const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, 0.5, seed))
      expect(Math.max(...mixes) - Math.min(...mixes)).toBeGreaterThan(0.55)
    }
  })

  it('converges the spread to zero at both ends', () => {
    // The same property as the exact endpoints, measured: at 0 and 1 the cloud has
    // no dispersion left, which is what makes the glyph a crisp shape.
    for (const phase of TRANSITIONS) {
      for (const progress of [0, 1]) {
        const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, progress, seed))
        expect(stdDev(mixes)).toBe(0)
      }
    }
  })

  it('straddles the plain curve rather than trailing it', () => {
    // The normalisation by `1 - spread` is what makes the band symmetric about the
    // phase's own curve in time: the lowest roll reaches the glyph early (at
    // progress 0.72, not 1) and the highest starts late (at 0.28). A stagger where
    // every particle merely lagged would drag the cloud's centre of mass behind the
    // phase ramp, which reads as the whole transition running late instead of as the
    // cloud separating into early and late arrivals.
    const sorted = [...SEEDS].sort((a, b) => staggerRoll(a) - staggerRoll(b))
    const lowest = sorted[0]
    const highest = sorted[sorted.length - 1]

    // The lowest roll leads: it is already finished while the plain curve climbs.
    expect(staggeredGlyphMix('gather', 0.75, lowest)).toBeGreaterThan(
      glyphMixFor('gather', 0.75)
    )
    // The highest roll trails: it has not started while the plain curve is moving.
    expect(staggeredGlyphMix('gather', 0.25, highest)).toBeLessThan(
      glyphMixFor('gather', 0.25)
    )
    // Both populations are real, not a hash fluke on one outlier.
    expect(staggerRoll(lowest)).toBeLessThan(0.05)
    expect(staggerRoll(highest)).toBeGreaterThan(0.95)

    // And both sides are populated at every interior sample across the seed set.
    for (let step = 1; step < 40; step++) {
      const progress = step / 40
      for (const phase of TRANSITIONS) {
        const plain = glyphMixFor(phase, progress)
        const mixes = SEEDS.map((seed) => staggeredGlyphMix(phase, progress, seed))
        expect(
          mixes.filter((mix) => mix > plain + 1e-12).length,
          `${phase} @ ${progress} had no leading particle`
        ).toBeGreaterThan(0)
        expect(
          mixes.filter((mix) => mix < plain - 1e-12).length,
          `${phase} @ ${progress} had no trailing particle`
        ).toBeGreaterThan(0)
      }
    }
  })

  it('orders the particles by roll: a lower roll is never ahead of a higher one', () => {
    // Monotone in the seed as well as in progress. A higher roll is held back
    // longer, so on a gather it reads a *lower* mix at the same instants — and if
    // that ordering could invert, two particles with adjacent rolls would swap
    // places mid-transition and the cloud would braid instead of gathering.
    const sorted = [...SEEDS].sort((a, b) => staggerRoll(a) - staggerRoll(b))
    for (let step = 1; step < 40; step++) {
      const progress = step / 40
      let previous = staggeredGlyphMix('gather', progress, sorted[0])
      for (const seed of sorted.slice(1)) {
        const mix = staggeredGlyphMix('gather', progress, seed)
        expect(
          mix,
          `seed ${seed} overtook a lower roll at progress ${progress}`
        ).toBeLessThanOrEqual(previous + 1e-12)
        previous = mix
      }
    }

    // The mirror for a scatter: a higher roll stays part of the glyph longer, so
    // there the ordering is the other way round.
    for (let step = 1; step < 40; step++) {
      const progress = step / 40
      let previous = staggeredGlyphMix('scatter', progress, sorted[0])
      for (const seed of sorted.slice(1)) {
        const mix = staggeredGlyphMix('scatter', progress, seed)
        expect(mix).toBeGreaterThanOrEqual(previous - 1e-12)
        previous = mix
      }
    }
  })
})

// ---------------------------------------------------------------------------
// spread = 0 and the identity with the engine's own curve
// ---------------------------------------------------------------------------

describe('staggeredGlyphMix with spread 0', () => {
  it('is bit-identical to the engine\'s glyphMixFor, for every phase and seed', () => {
    // This is what pins the two copies of the curve together. `glyphMixFor` lives
    // in ParticleEngine.ts (another lane's file) and the base curve is restated in
    // choreography.ts; asserting they agree is the only thing that keeps the
    // restatement honest.
    for (const phase of PHASES) {
      for (let step = 0; step <= 40; step++) {
        const progress = step / 40
        for (const seed of [0, 1, 42, 511]) {
          expect(staggeredGlyphMix(phase, progress, seed, 0)).toBe(
            glyphMixFor(phase, progress)
          )
        }
      }
    }
  })

  it('ignores out-of-range and non-finite spreads', () => {
    const at = (spread: number) => staggeredGlyphMix('gather', 0.5, 3, spread)
    // A spread >= 1 would divide by zero or invert the warp; it clamps.
    expect(Number.isFinite(at(1))).toBe(true)
    expect(Number.isFinite(at(5))).toBe(true)
    expect(Number.isFinite(at(-2))).toBe(true)
    expect(Number.isFinite(at(Number.NaN))).toBe(true)
    // Negative clamps to 0, which is the plain curve.
    expect(at(-2)).toBe(glyphMixFor('gather', 0.5))
    // NaN falls back to the shipped default rather than to the plain curve.
    expect(at(Number.NaN)).toBe(staggeredGlyphMix('gather', 0.5, 3))
  })

  it('widens the spread monotonically as the stagger grows', () => {
    const band = (spread: number) => {
      const mixes = SEEDS.map((seed) => staggeredGlyphMix('gather', 0.5, seed, spread))
      return Math.max(...mixes) - Math.min(...mixes)
    }
    const widths = [0, 0.1, GLYPH_STAGGER, 0.5].map(band)
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1])
    }
    expect(widths[0]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The baked-roll entry point
// ---------------------------------------------------------------------------

describe('staggeredGlyphMixFromRoll', () => {
  it('is what staggeredGlyphMix computes, for all 512 seeds', () => {
    for (const phase of PHASES) {
      for (const progress of [0, 0.17, 0.5, 0.83, 1]) {
        for (const seed of SEEDS) {
          expect(staggeredGlyphMix(phase, progress, seed)).toBe(
            staggeredGlyphMixFromRoll(phase, progress, staggerRoll(seed))
          )
        }
      }
    }
  })

  it('clamps a roll that is outside 0..1 and tolerates a non-finite one', () => {
    expect(staggeredGlyphMixFromRoll('gather', 0.5, -1)).toBe(
      staggeredGlyphMixFromRoll('gather', 0.5, 0)
    )
    expect(staggeredGlyphMixFromRoll('gather', 0.5, 2)).toBe(
      staggeredGlyphMixFromRoll('gather', 0.5, 1)
    )
    expect(Number.isFinite(staggeredGlyphMixFromRoll('gather', 0.5, Number.NaN))).toBe(
      true
    )
  })

  it('holds both endpoints for a roll at the extremes of the window', () => {
    for (const roll of [0, 0.5, 1]) {
      expect(staggeredGlyphMixFromRoll('gather', 0, roll)).toBe(0)
      expect(staggeredGlyphMixFromRoll('gather', 1, roll)).toBe(1)
      expect(staggeredGlyphMixFromRoll('scatter', 0, roll)).toBe(1)
      expect(staggeredGlyphMixFromRoll('scatter', 1, roll)).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The constant itself
// ---------------------------------------------------------------------------

describe('GLYPH_STAGGER', () => {
  it('sits in the range the derivation allows', () => {
    // Below ~0.05 the stagger is invisible; at 0.5 the latest particle has only
    // half the phase to travel and the glyph is still settling into `hold`.
    expect(GLYPH_STAGGER).toBeGreaterThan(0.05)
    expect(GLYPH_STAGGER).toBeLessThan(0.5)
    // The shipped value specifically — this test exists to make a deliberate
    // change to the constant show up in the diff rather than pass silently.
    expect(GLYPH_STAGGER).toBe(0.28)
  })

  it('leaves the last particle at least 70% of the phase to move', () => {
    // The endpoint property is what makes this safe, and this is the margin it
    // costs: `progress (1 - GLYPH_STAGGER)` of travel for the slowest particle.
    expect(1 - GLYPH_STAGGER).toBeGreaterThan(0.7)
    // In seconds, inside the shipped beat.
    const gather = 1.4
    const scatter = 1.1
    expect(gather * (1 - GLYPH_STAGGER)).toBeCloseTo(1.008, 3)
    expect(scatter * (1 - GLYPH_STAGGER)).toBeCloseTo(0.792, 3)
  })

  it('is the default when the argument is omitted', () => {
    for (const seed of [0, 5, 250]) {
      for (const progress of [0, 0.3, 0.7, 1]) {
        expect(staggeredGlyphMix('gather', progress, seed)).toBe(
          staggeredGlyphMix('gather', progress, seed, GLYPH_STAGGER)
        )
      }
    }
  })
})
