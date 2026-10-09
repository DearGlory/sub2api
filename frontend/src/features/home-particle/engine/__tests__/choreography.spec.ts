/**
 * Lane L2 — choreography contract.
 *
 * Pure logic, no DOM. The phase clock has to be testable with nothing but
 * arithmetic, because that is the only way to prove the 12.0 s beat is exactly
 * 12.0 s rather than "12.0 s on a 60 Hz monitor".
 *
 * A note on tolerances, since a lot of this file is about exactness. Where the
 * claim is *zero drift* the dt is an exact binary fraction (0.5, 0.25, 0.125,
 * 0.0625, 1/128) so the caller's own `elapsed += dt` lands on 12.0 in IEEE754 with
 * no error at all, and the assertion is `toBe`. Where the claim is only *framerate
 * independent*, awkward dt values are used deliberately and the tolerance is one dt
 * — the caller's sampling granularity, not the clock's own error.
 */
import { describe, expect, it } from 'vitest'
import { createChoreography } from '../choreography'
import type { Point3 } from '../choreography'
import type { Choreography, ChoreographyOptions, CometPhase } from '../types'
import {
  AMPLITUDE_X,
  CYCLE_SECONDS,
  GATHER_SECONDS,
  HOLD_SECONDS,
  LEG_SECONDS,
  SCATTER_SECONDS,
  SWAY_Y,
  SWAY_Z,
  TAIL_SECONDS,
} from '../constants'

const BRAND_COUNT = 28

/** Start of each phase within a beat, in seconds. */
const PHASE_START = {
  travel: 0,
  gather: LEG_SECONDS,
  hold: LEG_SECONDS + GATHER_SECONDS,
  scatter: LEG_SECONDS + GATHER_SECONDS + HOLD_SECONDS,
} as const
const PHASE_LENGTH = {
  travel: LEG_SECONDS,
  gather: GATHER_SECONDS,
  hold: HOLD_SECONDS,
  scatter: SCATTER_SECONDS,
} as const

const PHASES: CometPhase[] = ['travel', 'gather', 'hold', 'scatter']

function makeOptions(overrides: Partial<ChoreographyOptions> = {}): ChoreographyOptions {
  return {
    brandCount: BRAND_COUNT,
    amplitudeX: AMPLITUDE_X,
    swayY: SWAY_Y,
    swayZ: SWAY_Z,
    legSeconds: LEG_SECONDS,
    gatherSeconds: GATHER_SECONDS,
    holdSeconds: HOLD_SECONDS,
    scatterSeconds: SCATTER_SECONDS,
    ...overrides,
  }
}

/**
 * A choreography advanced to `offset` seconds inside `phase` of the first beat.
 *
 * Walking to the boundary and stopping on it would land in the *next* phase — the
 * boundaries are half-open — so the helper steps until the phase matches and only
 * then advances the offset.
 */
function choreoAt(phase: CometPhase, offset = 0): Choreography {
  const choreo = createChoreography(makeOptions())
  const dt = 1 / 2000
  let guard = 0
  while (choreo.state.phase !== phase) {
    choreo.update(dt)
    if (++guard > 2_000_000) throw new Error(`never reached phase ${phase}`)
  }
  let remaining = offset
  while (remaining > 0) {
    const step = Math.min(dt, remaining)
    choreo.update(step)
    remaining -= step
    if (++guard > 2_000_000) throw new Error(`never reached offset ${offset} in ${phase}`)
  }
  expect(choreo.state.phase, `helper landed in ${phase}`).toBe(phase)
  return choreo
}

/** Offsets that stay comfortably inside each phase (scatter is shortest, 1.1 s). */
const SAFE_OFFSETS: Record<CometPhase, number[]> = {
  travel: [0, 0.2, 2.0, 5.5],
  gather: [0.05, 0.5, 1.3],
  hold: [0.05, 1.5, 2.8],
  scatter: [0.05, 0.55, 1.0],
}

describe('choreography: beat timing', () => {
  it('the beat constants add up to the documented 12.0 s', () => {
    expect(LEG_SECONDS + GATHER_SECONDS + HOLD_SECONDS + SCATTER_SECONDS).toBe(12)
    expect(CYCLE_SECONDS).toBe(12)
  })

  it('one beat takes exactly CYCLE_SECONDS when dt divides the beat evenly', () => {
    // 0.5 is also the adversarial case: it lands exactly on the final phase
    // boundary, so an implementation that mishandles the boundary overshoots a whole
    // beat here and this fails loudly rather than drifting quietly.
    for (const dt of [0.5, 0.25, 0.125, 0.0625, 1 / 128]) {
      const choreo = createChoreography(makeOptions())
      let elapsed = 0
      let steps = 0
      while (choreo.state.legIndex === 0) {
        choreo.update(dt)
        elapsed += dt
        if (++steps > 100000) throw new Error(`dt=${dt} never finished a beat`)
      }
      expect(elapsed, `dt=${dt}`).toBe(CYCLE_SECONDS)
      expect(Math.abs(elapsed - CYCLE_SECONDS), `dt=${dt}`).toBeLessThan(1e-6)
      expect(steps, `dt=${dt}`).toBe(CYCLE_SECONDS / dt)
    }
  })

  it('one beat lands within one dt of CYCLE_SECONDS for awkward dt', () => {
    // 0.1, 1/60 and 1/144 cannot represent 12.0 exactly, so a caller sampling at that
    // granularity may legitimately observe the phase flip one frame late. The clock
    // must not add to that error: one dt of tolerance, and no more.
    for (const dt of [0.1, 0.017, 1 / 30, 1 / 60, 1 / 144]) {
      const choreo = createChoreography(makeOptions())
      let elapsed = 0
      let steps = 0
      while (choreo.state.legIndex === 0) {
        choreo.update(dt)
        elapsed += dt
        if (++steps > 100000) throw new Error(`dt=${dt} never finished a beat`)
      }
      expect(Math.abs(elapsed - CYCLE_SECONDS), `dt=${dt}`).toBeLessThanOrEqual(dt + 1e-9)
    }
  })

  it('accumulating dt in 0.5 s slices lands on the beat end with no drift', () => {
    const choreo = createChoreography(makeOptions())
    let elapsed = 0
    for (let i = 0; i < 24; i++) {
      choreo.update(0.5)
      elapsed += 0.5
    }
    expect(elapsed).toBe(CYCLE_SECONDS)
    // The 24th step starts beat 1 exactly, so legIndex has just moved to 1 — and an
    // odd leg departs from the *right* extreme, which is where leg 0 arrived. The
    // sweep is therefore continuous across the beat, never a jump back to the left.
    expect(choreo.state.legIndex).toBe(1)
    expect(choreo.state.phase).toBe('travel')
    expect(choreo.state.phaseProgress).toBe(0)
    expect(choreo.state.headX).toBe(AMPLITUDE_X)
  })

  it('phase boundaries land where the design doc puts them', () => {
    const choreo = createChoreography(makeOptions())
    const seen: Array<{ phase: CometPhase; at: number }> = [
      { phase: choreo.state.phase, at: 0 },
    ]
    let elapsed = 0
    const dt = 0.001
    let previous = choreo.state.phase
    while (elapsed < CYCLE_SECONDS + dt) {
      choreo.update(dt)
      elapsed += dt
      if (choreo.state.phase !== previous) {
        seen.push({ phase: choreo.state.phase, at: elapsed })
        previous = choreo.state.phase
      }
    }
    expect(seen.map((entry) => entry.phase)).toEqual([
      'travel',
      'gather',
      'hold',
      'scatter',
      'travel',
    ])
    // Each boundary is detected on the first frame past it, hence the dt allowance.
    expect(Math.abs(seen[1].at - PHASE_START.gather)).toBeLessThanOrEqual(dt)
    expect(Math.abs(seen[2].at - PHASE_START.hold)).toBeLessThanOrEqual(dt)
    expect(Math.abs(seen[3].at - PHASE_START.scatter)).toBeLessThanOrEqual(dt)
    expect(Math.abs(seen[4].at - CYCLE_SECONDS)).toBeLessThanOrEqual(dt)
  })

  it('hold lasts exactly HOLD_SECONDS (3.0 s) with binary-exact dt', () => {
    for (const dt of [0.5, 0.25, 0.125, 0.0625]) {
      const choreo = createChoreography(makeOptions())
      let frames = 0
      let entered = false
      let guard = 0
      while (!entered || choreo.state.phase === 'hold') {
        choreo.update(dt)
        if (choreo.state.phase === 'hold') {
          entered = true
          frames += 1
        }
        if (++guard > 100000) throw new Error(`dt=${dt} never left hold`)
      }
      // Frames observable in hold, measured exactly: 3.0 s is 6, 12, 24, 48 frames.
      expect(frames * dt, `dt=${dt}`).toBe(HOLD_SECONDS)
      expect(frames, `dt=${dt}`).toBe(HOLD_SECONDS / dt)
    }
  })

  it('hold duration is within one dt of HOLD_SECONDS for awkward dt', () => {
    for (const dt of [0.1, 1 / 60, 1 / 144]) {
      const choreo = createChoreography(makeOptions())
      let frames = 0
      let entered = false
      let guard = 0
      while (!entered || choreo.state.phase === 'hold') {
        choreo.update(dt)
        if (choreo.state.phase === 'hold') {
          entered = true
          frames += 1
        }
        if (++guard > 100000) throw new Error(`dt=${dt} never left hold`)
      }
      expect(Math.abs(frames * dt - HOLD_SECONDS), `dt=${dt}`).toBeLessThanOrEqual(dt + 1e-9)
    }
  })

  it('hold is the longest stationary window of the beat', () => {
    // Guards against a future edit silently reordering the beat: the user asked for
    // exactly 3 s of stillness, which has to dominate the two transitions combined —
    // otherwise the glyph spends longer dissolving than it does being readable.
    expect(HOLD_SECONDS).toBeGreaterThan(GATHER_SECONDS)
    expect(HOLD_SECONDS).toBeGreaterThan(SCATTER_SECONDS)
    expect(HOLD_SECONDS).toBeGreaterThan(GATHER_SECONDS + SCATTER_SECONDS)
  })

  it('phaseProgress runs 0..1 inside every phase', () => {
    const choreo = createChoreography(makeOptions())
    const dt = 1 / 240
    let previousPhase = choreo.state.phase
    let previousProgress = -1
    let elapsed = 0
    while (elapsed < CYCLE_SECONDS * 2) {
      choreo.update(dt)
      elapsed += dt
      const { phase, phaseProgress } = choreo.state
      expect(phaseProgress).toBeGreaterThanOrEqual(0)
      expect(phaseProgress).toBeLessThanOrEqual(1)
      if (phase === previousPhase) {
        // Same phase: progress must not run backwards.
        expect(phaseProgress).toBeGreaterThanOrEqual(previousProgress)
      } else {
        // New phase: the progress is one frame in, at most dt / SCATTER_SECONDS.
        expect(phaseProgress).toBeLessThan(0.02)
      }
      previousPhase = phase
      previousProgress = phaseProgress
    }
  })
})

describe('choreography: brand and leg advance', () => {
  it('advances brandIndex by exactly one per beat and wraps after the roster', () => {
    const choreo = createChoreography(makeOptions())
    const seen: number[] = [choreo.state.brandIndex]
    for (let beat = 0; beat < BRAND_COUNT + 1; beat++) {
      choreo.update(CYCLE_SECONDS)
      seen.push(choreo.state.brandIndex)
    }
    expect(seen).toHaveLength(BRAND_COUNT + 2)
    expect(seen[0]).toBe(0)
    // 28 beats visit 1..27 then wrap to 0; the 29th beat starts at 1 again.
    expect(seen.slice(1, BRAND_COUNT)).toEqual(
      Array.from({ length: BRAND_COUNT - 1 }, (_, i) => i + 1)
    )
    expect(seen[BRAND_COUNT]).toBe(0)
    expect(seen[BRAND_COUNT + 1]).toBe(1)
  })

  it('wraps on whatever roster size the caller passes, not a hardcoded 28', () => {
    for (const brandCount of [1, 2, 3, 5, 28]) {
      const choreo = createChoreography(makeOptions({ brandCount }))
      const visited: number[] = []
      for (let beat = 0; beat < brandCount * 2; beat++) {
        visited.push(choreo.state.brandIndex)
        choreo.update(CYCLE_SECONDS)
      }
      expect(visited, `brandCount=${brandCount}`).toEqual(
        Array.from({ length: brandCount * 2 }, (_, i) => i % brandCount)
      )
      expect(choreo.state.brandIndex, `brandCount=${brandCount}`).toBe(0)
    }
  })

  it('legIndex increments once per completed beat', () => {
    const choreo = createChoreography(makeOptions())
    for (let beat = 0; beat < 10; beat++) {
      expect(choreo.state.legIndex).toBe(beat)
      choreo.update(CYCLE_SECONDS)
    }
    expect(choreo.state.legIndex).toBe(10)
  })

  it('alternates the travel direction through legIndex parity', () => {
    const choreo = createChoreography(makeOptions())
    const legs: Array<{ leg: number; from: number; to: number }> = []
    for (let beat = 0; beat < 4; beat++) {
      legs.push({
        leg: choreo.state.legIndex,
        from: choreo.state.fromX,
        to: choreo.state.toX,
      })
      choreo.update(CYCLE_SECONDS)
    }
    expect(legs).toEqual([
      { leg: 0, from: -AMPLITUDE_X, to: AMPLITUDE_X },
      { leg: 1, from: AMPLITUDE_X, to: -AMPLITUDE_X },
      { leg: 2, from: -AMPLITUDE_X, to: AMPLITUDE_X },
      { leg: 3, from: AMPLITUDE_X, to: -AMPLITUDE_X },
    ])
    // Adjacent legs always mirror, never repeat.
    for (let i = 1; i < legs.length; i++) expect(legs[i].from).toBe(-legs[i - 1].from)
  })

  it('keeps fromX/toX fixed for the whole beat, including hold and scatter', () => {
    const choreo = createChoreography(makeOptions())
    const { fromX, toX } = choreo.state
    const dt = 0.125
    const visited: CometPhase[] = []
    // Assert before advancing and stop the instant the beat rolls over: the leg
    // fields describe the running leg, so they must not change mid-beat.
    while (choreo.state.legIndex === 0) {
      expect(choreo.state.fromX).toBe(fromX)
      expect(choreo.state.toX).toBe(toX)
      visited.push(choreo.state.phase)
      choreo.update(dt)
    }
    expect(visited).toContain('travel')
    expect(visited).toContain('hold')
    expect(visited).toContain('scatter')
  })

  it('nextBrand advances without touching the phase clock', () => {
    const choreo = createChoreography(makeOptions({ brandCount: 3 }))
    choreo.update(2)
    const phase = choreo.state.phase
    const progress = choreo.state.phaseProgress
    const leg = choreo.state.legIndex
    const headX = choreo.state.headX

    choreo.nextBrand()
    expect(choreo.state.brandIndex).toBe(1)
    choreo.nextBrand()
    expect(choreo.state.brandIndex).toBe(2)
    choreo.nextBrand()
    // 0 -> 1 -> 2 -> 0: three advances return to the start of a 3-brand roster.
    expect(choreo.state.brandIndex).toBe(0)
    expect(choreo.state.phase).toBe(phase)
    expect(choreo.state.phaseProgress).toBe(progress)
    expect(choreo.state.legIndex).toBe(leg)
    expect(choreo.state.headX).toBe(headX)
  })
})

describe('choreography: the head reaches the extremes', () => {
  it('gathers only at +/-amplitudeX: the head is at an extreme when gather starts', () => {
    const dt = 0.001
    const choreo = createChoreography(makeOptions())
    let elapsed = 0
    let previous = choreo.state.phase
    const arrivals: Array<{ x: number; expected: number }> = []
    while (elapsed < CYCLE_SECONDS * 3) {
      const expected = choreo.state.toX
      choreo.update(dt)
      elapsed += dt
      if (previous === 'travel' && choreo.state.phase === 'gather') {
        arrivals.push({ x: choreo.state.headX, expected })
      }
      previous = choreo.state.phase
    }
    expect(arrivals).toHaveLength(3)
    arrivals.forEach((arrival, index) => {
      // The glyph forms at an extreme, not part-way along the route: within one dt of
      // the eased travel curve, cos easing leaves the head ~4.4e-5 short per ms.
      expect(Math.abs(Math.abs(arrival.x) - AMPLITUDE_X), `arrival ${index}`).toBeLessThan(1e-3)
      // ...at the extreme the leg was *heading* for...
      expect(arrival.x, `arrival ${index}`).toBeCloseTo(arrival.expected, 2)
      // ...and the extremes alternate left/right every beat.
      expect(Math.sign(arrival.x)).toBe(index % 2 === 0 ? 1 : -1)
    })
  })

  it('headX is monotone along a leg and slows at both ends', () => {
    const choreo = createChoreography(makeOptions())
    const dt = 1 / 240
    const samples: Array<{ x: number }> = []
    while (choreo.state.phase === 'travel') {
      samples.push({ x: choreo.state.headX })
      choreo.update(dt)
    }
    expect(samples.length).toBeGreaterThan(1000)
    expect(samples[0].x).toBeCloseTo(-AMPLITUDE_X, 3)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].x).toBeGreaterThan(samples[i - 1].x)
    }
    const firstStep = samples[1].x - samples[0].x
    const middleIndex = Math.floor(samples.length / 2)
    const middleStep = samples[middleIndex + 1].x - samples[middleIndex].x
    const lastStep = samples[samples.length - 1].x - samples[samples.length - 2].x
    // cos easing: fastest in the middle, near-stationary at both extremes. That is
    // the "arrival" feel, and it is what gives the glyph a still instant to form in.
    expect(middleStep).toBeGreaterThan(firstStep * 10)
    expect(middleStep).toBeGreaterThan(lastStep * 10)
  })

  it('holds the glyph position still through gather, hold and scatter', () => {
    const dt = 1 / 240
    const choreo = createChoreography(makeOptions())
    while (choreo.state.phase === 'travel') choreo.update(dt)
    const anchor = { x: choreo.state.headX, y: choreo.state.headY, z: choreo.state.headZ }
    // The stationary phases pin the head to the extreme exactly, so the glyph centre
    // is `toX` to the last bit — not the eased value the last travel frame reached.
    expect(anchor.x).toBe(AMPLITUDE_X)
    expect(anchor.y).toBe(0)
    expect(anchor.z).toBe(0)
    while (choreo.state.phase !== 'travel') {
      expect(choreo.state.headX).toBe(anchor.x)
      expect(choreo.state.headY).toBe(anchor.y)
      expect(choreo.state.headZ).toBe(anchor.z)
      choreo.update(dt)
    }
    // And the next leg starts from that same point, so nothing teleports. It has
    // already advanced one frame into the new leg (that is what ended the loop), so
    // it is a frame of travel away at most — leg 1 runs +amp -> -amp.
    expect(choreo.state.legIndex).toBe(1)
    expect(choreo.state.phase).toBe('travel')
    expect(choreo.state.phaseProgress).toBeLessThan(0.01)
    expect(choreo.state.headX).toBeLessThanOrEqual(anchor.x)
    expect(Math.abs(choreo.state.headX - anchor.x)).toBeLessThan(0.01)
  })

  it('travel is a genuine 3D S: depth peaks mid-leg and returns to zero at both ends', () => {
    const choreo = createChoreography(makeOptions())
    const dt = 1 / 240
    let minZ = 0
    let maxAbsY = 0
    while (choreo.state.phase === 'travel') {
      const { headY, headZ, phaseProgress } = choreo.state
      minZ = Math.min(minZ, headZ)
      maxAbsY = Math.max(maxAbsY, Math.abs(headY))
      // Both ends sit on the glyph plane, so travel and gather meet with no pop:
      // measured 2.5e-5 out at progress 0.999, i.e. a rounding error.
      if (phaseProgress < 0.001 || phaseProgress > 0.999) {
        expect(Math.abs(headY)).toBeLessThan(0.05)
        expect(Math.abs(headZ)).toBeLessThan(0.05)
      }
      choreo.update(dt)
    }
    // Depth is one-sided (always toward the glyph plane) and reaches the full
    // SWAY_Z at mid-leg, which is what separates it from the vertical sine.
    expect(minZ).toBeCloseTo(-SWAY_Z, 2)
    expect(maxAbsY).toBeCloseTo(SWAY_Y, 3)

    // In quadrature, not in phase. The vertical sway peaks where the eased progress
    // is exactly 1/4 — i.e. at progress 1/3 of the leg, since e = (1-cos(pi*p))/2 —
    // and at that instant the depth is exactly half-swung. A planar curve (z = k*y)
    // would peak both together and read as a flat wiggle rather than a helix.
    const yPeak = choreoAt('travel', LEG_SECONDS / 3)
    expect(yPeak.state.phaseProgress).toBeCloseTo(1 / 3, 2)
    expect(yPeak.state.headY).toBeCloseTo(SWAY_Y, 2)
    expect(yPeak.state.headZ).toBeCloseTo(-SWAY_Z / 2, 2)

    // And the depth peak is at mid-leg, where the vertical sway is back to zero.
    const zPeak = choreoAt('travel', LEG_SECONDS / 2)
    expect(zPeak.state.headZ).toBeCloseTo(-SWAY_Z, 2)
    expect(zPeak.state.headY).toBeCloseTo(0, 6)
  })

  it('flips the vertical lobe on odd legs so the two halves of the S mirror', () => {
    const dt = 1 / 240
    const choreo = createChoreography(makeOptions())
    const lobes: number[] = []
    for (let leg = 0; leg < 2; leg++) {
      // Sample just past the vertical peak at progress 1/3.
      while (choreo.state.phase === 'travel' && choreo.state.phaseProgress < 0.34) {
        choreo.update(dt)
      }
      expect(choreo.state.phaseProgress).toBeGreaterThanOrEqual(0.34)
      lobes.push(choreo.state.headY)
      while (choreo.state.legIndex === leg) choreo.update(dt)
    }
    expect(lobes[0]).toBeCloseTo(SWAY_Y, 2)
    expect(lobes[1]).toBeCloseTo(-SWAY_Y, 2)
    expect(lobes[0]).toBeCloseTo(-lobes[1], 6)
  })
})

describe('choreography: sampleTrail', () => {
  it('returns finite numbers for every delay in [0, TAIL_SECONDS] in all four phases', () => {
    // The headline requirement: a NaN here is a particle teleporting to the origin
    // and the tail flickering once per beat.
    let samples = 0
    for (const phase of PHASES) {
      for (const offset of SAFE_OFFSETS[phase]) {
        const choreo = choreoAt(phase, offset)
        const out: Point3 = { x: NaN, y: NaN, z: NaN }
        for (let i = 0; i <= 200; i++) {
          const delay = (i / 200) * TAIL_SECONDS
          out.x = NaN
          out.y = NaN
          out.z = NaN
          choreo.sampleTrail(delay, out)
          const label = `phase=${phase} offset=${offset} delay=${delay}`
          expect(Number.isFinite(out.x), `${label} x=${out.x}`).toBe(true)
          expect(Number.isFinite(out.y), `${label} y=${out.y}`).toBe(true)
          expect(Number.isFinite(out.z), `${label} z=${out.z}`).toBe(true)
          // And inside the envelope the particles are actually drawn in.
          expect(Math.abs(out.x), label).toBeLessThanOrEqual(AMPLITUDE_X + 1e-9)
          expect(Math.abs(out.y), label).toBeLessThanOrEqual(SWAY_Y + 1e-9)
          expect(Math.abs(out.z), label).toBeLessThanOrEqual(SWAY_Z + 1e-9)
          samples += 1
        }
      }
    }
    // 13 offsets x 201 delays: the whole delay range, every phase.
    expect(samples).toBe(13 * 201)
    expect(samples).toBeGreaterThan(2000)
  })

  it('delay = 0 is exactly the head', () => {
    for (const phase of PHASES) {
      const choreo = choreoAt(phase, 0.6)
      const out: Point3 = { x: 0, y: 0, z: 0 }
      choreo.sampleTrail(0, out)
      expect(out.x, phase).toBe(choreo.state.headX)
      expect(out.y, phase).toBe(choreo.state.headY)
      expect(out.z, phase).toBe(choreo.state.headZ)
    }
  })

  it('replays backwards along the S-curve during travel without jumping', () => {
    const choreo = createChoreography(makeOptions())
    for (let i = 0; i < 240; i++) choreo.update(1 / 60) // 4 s in: whole tail in the leg
    expect(choreo.state.phase).toBe('travel')
    const out: Point3 = { x: 0, y: 0, z: 0 }
    let previous = Infinity
    let largestGap = 0
    for (let i = 0; i <= 260; i++) {
      const delay = (i / 260) * TAIL_SECONDS
      choreo.sampleTrail(delay, out)
      // Further back in time => further back along the leg (leg 0 runs -amp -> +amp).
      expect(out.x, `delay=${delay}`).toBeLessThan(previous)
      // And still inside the leg's own envelope: this is the real past, not an
      // extrapolation past the extreme.
      expect(out.x).toBeGreaterThanOrEqual(-AMPLITUDE_X - 1e-9)
      if (previous !== Infinity) largestGap = Math.max(largestGap, previous - out.x)
      previous = out.x
    }
    // Smooth: no step across the whole 2.6 s tail is big enough to read as a jump.
    expect(largestGap).toBeLessThan(0.6)
    // The far end of the tail is 2.6 s back down the leg, near the leg's start.
    expect(previous).toBeCloseTo(-AMPLITUDE_X + 18 * (1 - Math.cos(Math.PI * (4 - 2.6) / LEG_SECONDS)) / 2, 6)
  })

  it('converges onto the glyph by the end of hold, so the tail shortens as the shape forms', () => {
    // One frame into gather the tail is still stretched back down the S-leg...
    const early = choreoAt('gather', 0.05)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    early.sampleTrail(TAIL_SECONDS, out)
    const earlySpread = Math.abs(out.x - early.state.headX)
    expect(earlySpread).toBeGreaterThan(1)

    // ...and by the end of hold the reachable past is all stationary phases, so the
    // sampled point has collapsed onto the glyph centre. The tail only clears the leg
    // once gather + part of hold exceeds TAIL_SECONDS, which is why the whole third
    // act is stationary in the first place: the shape is fully formed before the
    // comet's tail has finished arriving.
    const settled = choreoAt('hold', 2.8)
    for (let i = 0; i <= 100; i++) {
      settled.sampleTrail((i / 100) * TAIL_SECONDS, out)
      expect(Math.abs(out.x - settled.state.headX)).toBeLessThan(1e-9)
      expect(Math.abs(out.y - settled.state.headY)).toBeLessThan(1e-9)
      expect(Math.abs(out.z - settled.state.headZ)).toBeLessThan(1e-9)
    }

    // ...and it is a progression, not a switch: the spread shrinks monotonically.
    const spreadAt = (phase: CometPhase, offset: number) => {
      const choreo = choreoAt(phase, offset)
      choreo.sampleTrail(TAIL_SECONDS, out)
      return Math.abs(out.x - choreo.state.headX)
    }
    const spread = [
      spreadAt('travel', 5.5),
      spreadAt('gather', 0.05),
      spreadAt('gather', 1.3),
      spreadAt('hold', 1.5),
      spreadAt('hold', 2.8),
    ]
    for (let i = 1; i < spread.length; i++) {
      expect(spread[i], `spread index ${i}`).toBeLessThanOrEqual(spread[i - 1] + 1e-9)
    }
    expect(spread[spread.length - 1]).toBe(0)
  })

  it('crosses the beat boundary without a seam', () => {
    // In early travel of beat 1 the tail reaches back through beat 0's scatter and
    // hold, which were stationary at the *other* extreme. Leg 1 runs +amp -> -amp, so
    // going back in time always moves right and the far end of the tail is pinned at
    // beat 0's arrival point. An implementation that reset its clock per beat — or
    // kept a history buffer it flushed — would snap here.
    const choreo = createChoreography(makeOptions())
    choreo.update(CYCLE_SECONDS)
    choreo.update(0.4)
    expect(choreo.state.legIndex).toBe(1)
    expect(choreo.state.phase).toBe('travel')
    expect(choreo.state.headX).toBeLessThan(AMPLITUDE_X)

    const out: Point3 = { x: 0, y: 0, z: 0 }
    let previousX = -Infinity
    const xs: number[] = []
    for (let i = 0; i <= 400; i++) {
      const delay = (i / 400) * TAIL_SECONDS
      choreo.sampleTrail(delay, out)
      expect(Number.isFinite(out.x)).toBe(true)
      expect(Math.abs(out.x)).toBeLessThanOrEqual(AMPLITUDE_X + 1e-9)
      expect(out.x, `delay=${delay}`).toBeGreaterThanOrEqual(previousX - 1e-9)
      previousX = out.x
      xs.push(out.x)
    }
    // The seam is smooth, not a step: no delay pair jumps a visible distance.
    const biggestStep = xs.reduce(
      (worst, value, index) =>
        index === 0 ? worst : Math.max(worst, Math.abs(value - xs[index - 1])),
      0
    )
    expect(biggestStep).toBeLessThan(0.2)
    // The far end of the tail is pinned at the previous beat's extreme, which is the
    // same point the current head left from — so the trail spans the turn.
    expect(xs[xs.length - 1]).toBeCloseTo(AMPLITUDE_X, 6)
    expect(xs[0]).toBeCloseTo(choreo.state.headX, 6)
  })

  it('clamps a delay past the tail length and survives garbage input', () => {
    const choreo = createChoreography(makeOptions())
    choreo.update(3)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    for (const delay of [TAIL_SECONDS + 1, 30, 1000, 1e6]) {
      choreo.sampleTrail(delay, out)
      expect(Number.isFinite(out.x), `delay=${delay}`).toBe(true)
      expect(Number.isFinite(out.y), `delay=${delay}`).toBe(true)
      expect(Number.isFinite(out.z), `delay=${delay}`).toBe(true)
    }
    for (const delay of [-1, -100, NaN, Infinity, -Infinity]) {
      out.x = NaN
      out.y = NaN
      out.z = NaN
      choreo.sampleTrail(delay, out)
      expect(Number.isFinite(out.x), `delay=${delay}`).toBe(true)
      expect(Number.isFinite(out.y), `delay=${delay}`).toBe(true)
      expect(Number.isFinite(out.z), `delay=${delay}`).toBe(true)
    }
  })

  it('writes into the caller-supplied object (zero-allocation contract)', () => {
    const choreo = createChoreography(makeOptions())
    choreo.update(3)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    const returned = choreo.sampleTrail(1, out)
    expect(returned).toBeUndefined()
    expect(out.x).not.toBe(0)
  })

  it('is a pure function of the delay: repeated calls agree', () => {
    // §6 item 2: this runs once per trail particle per frame, so it must allocate
    // nothing and must not depend on any hidden iteration state.
    const choreo = createChoreography(makeOptions())
    choreo.update(3)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    const first: Point3[] = []
    for (let i = 0; i <= 50; i++) {
      choreo.sampleTrail(i / 20, out)
      first.push({ ...out })
    }
    for (let i = 0; i <= 50; i++) {
      choreo.sampleTrail(i / 20, out)
      expect(out.x, `delay=${i / 20}`).toBe(first[i].x)
      expect(out.y).toBe(first[i].y)
      expect(out.z).toBe(first[i].z)
    }
    // Out-of-order access gives the same answers too (no cursor to rewind).
    for (let i = 50; i >= 0; i--) {
      choreo.sampleTrail(i / 20, out)
      expect(out.x, `reverse delay=${i / 20}`).toBe(first[i].x)
    }
  })

  it('replays a delay before the first beat by walking back past leg 0', () => {
    // Regression guard for the negative-clock branch: at t = 0.5 s a 2.6 s delay
    // lands in beat -1, whose travel leg ran the same direction as leg 0.
    const choreo = createChoreography(makeOptions())
    choreo.update(0.5)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    choreo.sampleTrail(TAIL_SECONDS, out)
    expect(Number.isFinite(out.x)).toBe(true)
    expect(out.x).toBeLessThan(choreo.state.headX)
    expect(out.x).toBeGreaterThanOrEqual(-AMPLITUDE_X - 1e-9)
    // Beat -1's arrival sits at the same extreme the current leg started from.
    expect(out.x).toBeCloseTo(-AMPLITUDE_X, 6)
  })

  it('replays an arbitrarily long delay without leaving the route', () => {
    // The engine is free to pass its own tail length, so the wrap has to be correct
    // for many beats back, not just one.
    const choreo = createChoreography(makeOptions())
    choreo.update(9)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    for (const delay of [13, 24.5, 100, 3000.25]) {
      choreo.sampleTrail(delay, out)
      expect(Number.isFinite(out.x), `delay=${delay}`).toBe(true)
      expect(Math.abs(out.x), `delay=${delay}`).toBeLessThanOrEqual(AMPLITUDE_X + 1e-9)
      expect(Math.abs(out.y), `delay=${delay}`).toBeLessThanOrEqual(SWAY_Y + 1e-9)
      expect(Math.abs(out.z), `delay=${delay}`).toBeLessThanOrEqual(SWAY_Z + 1e-9)
    }
  })
})

describe('choreography: framerate independence', () => {
  /** Everything a caller can observe, for comparing two schedules. */
  function snapshot(choreo: Choreography) {
    const out: Point3 = { x: 0, y: 0, z: 0 }
    choreo.sampleTrail(1, out)
    return { ...choreo.state, trailAt1s: { ...out } }
  }

  it('is bit-identical for equal elapsed time when every dt is exact', () => {
    // Callers that reach the same total with exact binary arithmetic must land on
    // identical state: the clock is a function of seconds elapsed and nothing else.
    // 0.5, 0.25, 0.125 and 0.0625 all divide each of these totals exactly.
    for (const total of [3.5, 6.5, 12, 25.5]) {
      let reference: ReturnType<typeof snapshot> | null = null
      for (const dt of [0.5, 0.25, 0.125, 0.0625]) {
        const steps = Math.round(total / dt)
        expect(steps * dt, `total=${total} dt=${dt}`).toBe(total)
        const choreo = createChoreography(makeOptions())
        for (let i = 0; i < steps; i++) choreo.update(dt)
        const current = snapshot(choreo)
        if (reference === null) reference = current
        else expect(current, `total=${total} dt=${dt}`).toEqual(reference)
      }
    }
  })

  it('agrees on phase state within one dt for awkward schedules', () => {
    // The bug this guards: driving the clock by frame count instead of by seconds.
    // The tolerance is one dt of the coarsest schedule, i.e. the caller's own
    // sampling granularity, expressed in seconds of phase time.
    for (const total of [3.25, 7.95, 9.5, 25.5]) {
      const reference = createChoreography(makeOptions())
      const referenceSteps = 200000
      const referenceDt = total / referenceSteps
      for (let i = 0; i < referenceSteps; i++) reference.update(referenceDt)

      for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.5, 0.1]) {
        const steps = Math.round(total / dt)
        const elapsed = steps * dt
        const choreo = createChoreography(makeOptions())
        for (let i = 0; i < steps; i++) choreo.update(dt)
        const label = `total=${total} dt=${dt}`

        // The schedule itself only differs by its own rounding, not the clock's.
        expect(Math.abs(elapsed - total), label).toBeLessThanOrEqual(dt / 2 + 1e-9)
        expect(choreo.state.legIndex, label).toBe(Math.floor(elapsed / CYCLE_SECONDS))
        expect(choreo.state.brandIndex, label).toBe(
          Math.floor(elapsed / CYCLE_SECONDS) % BRAND_COUNT
        )
        expect(reference.state.legIndex, label).toBe(Math.floor(total / CYCLE_SECONDS))

        expect(Number.isFinite(choreo.state.headX), label).toBe(true)
        expect(choreo.state.phaseProgress, label).toBeGreaterThanOrEqual(0)
        expect(choreo.state.phaseProgress, label).toBeLessThanOrEqual(1)

        // Where the two land in the same phase, the positions must agree to within a
        // frame's worth of travel.
        if (choreo.state.phase === reference.state.phase) {
          const phaseSeconds =
            Math.abs(choreo.state.phaseProgress - reference.state.phaseProgress) *
            PHASE_LENGTH[choreo.state.phase]
          expect(phaseSeconds, label).toBeLessThanOrEqual(dt + 1e-6)
          const travelSpeed = (2 * AMPLITUDE_X * Math.PI) / (2 * LEG_SECONDS)
          expect(
            Math.abs(choreo.state.headX - reference.state.headX),
            label
          ).toBeLessThanOrEqual(travelSpeed * dt + 1e-6)
        }

        const out: Point3 = { x: 0, y: 0, z: 0 }
        choreo.sampleTrail(1, out)
        expect(Number.isFinite(out.x), label).toBe(true)
      }
    }
  })

  it('treats a zero, negative or NaN delta as no time passing', () => {
    const choreo = createChoreography(makeOptions())
    choreo.update(2)
    const before = { ...choreo.state }
    for (const dt of [0, -1, -0.5, NaN, Infinity, -Infinity]) choreo.update(dt)
    expect(choreo.state.phase).toBe(before.phase)
    expect(choreo.state.phaseProgress).toBe(before.phaseProgress)
    expect(choreo.state.legIndex).toBe(before.legIndex)
    expect(choreo.state.brandIndex).toBe(before.brandIndex)
    expect(choreo.state.headX).toBe(before.headX)
    expect(choreo.state.headY).toBe(before.headY)
    expect(choreo.state.headZ).toBe(before.headZ)
  })

  it('survives a huge catch-up step without iterating or losing the beat', () => {
    // A tab that was asleep for six hours: 6 * 3600 / 12 = 1800 beats.
    const sixHours = 6 * 3600
    const beats = sixHours / CYCLE_SECONDS
    expect(beats).toBe(1800)

    const choreo = createChoreography(makeOptions())
    const started = Date.now()
    choreo.update(sixHours)
    const elapsedMs = Date.now() - started
    // O(1) wrap, not a loop over 1800 beats: three divisions. Anything slow here
    // means the wrap is a while-loop, which also blocks the main thread on resume.
    expect(elapsedMs).toBeLessThan(50)

    expect(choreo.state.phase).toBe('travel')
    expect(choreo.state.phaseProgress).toBe(0)
    expect(choreo.state.legIndex).toBe(beats)
    expect(choreo.state.brandIndex).toBe(beats % BRAND_COUNT)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    choreo.sampleTrail(TAIL_SECONDS, out)
    expect(Number.isFinite(out.x)).toBe(true)

    // One more frame continues normally from the resumed beat.
    choreo.update(0.5)
    expect(choreo.state.legIndex).toBe(beats)
    expect(choreo.state.phaseProgress).toBeGreaterThan(0)
  })

  it('stays finite and drift-free over three minutes at 60 fps', () => {
    const choreo = createChoreography(makeOptions())
    const dt = 1 / 60
    const frames = 60 * 60 * 3
    const out: Point3 = { x: 0, y: 0, z: 0 }
    for (let frame = 0; frame < frames; frame++) {
      choreo.update(dt)
      if (frame % 37 === 0) {
        choreo.sampleTrail(((frame % 260) / 260) * TAIL_SECONDS, out)
        expect(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)).toBe(
          true
        )
      }
    }
    // 10800 frames of 1/60 sums to 180.00000000000004 s in IEEE754, so the clock sits
    // a rounding error into beat 15 rather than exactly on its boundary. A whole beat
    // of drift would put this at 29 or 60 instead, so 15 is the claim being tested.
    expect(choreo.state.legIndex).toBe(15)
    expect(choreo.state.brandIndex).toBe(15 % BRAND_COUNT)
    expect(choreo.state.phase).toBe('travel')
    expect(choreo.state.phaseProgress).toBeLessThan(1e-9)
    expect(Number.isFinite(choreo.state.headX)).toBe(true)
    // At the start of leg 15 (odd) the head is at the left extreme... which for an
    // odd leg is +amplitude, since odd legs run +amp -> -amp.
    expect(choreo.state.headX).toBeCloseTo(AMPLITUDE_X, 3)
  })
})

describe('choreography: option handling', () => {
  it('falls back to the frozen constants rather than producing NaN', () => {
    const bad = makeOptions({
      legSeconds: NaN,
      gatherSeconds: 0,
      holdSeconds: Number.POSITIVE_INFINITY,
      scatterSeconds: -1,
      amplitudeX: NaN,
      swayY: NaN,
      swayZ: NaN,
      brandCount: NaN,
    })
    const choreo = createChoreography(bad)
    for (const key of ['headX', 'headY', 'headZ', 'fromX', 'toX'] as const) {
      expect(Number.isFinite(choreo.state[key]), key).toBe(true)
    }
    expect(Number.isFinite(choreo.state.phaseProgress)).toBe(true)
    // The timeline is still sane: every rejected duration fell back to the frozen
    // constant, so a beat still completes in CYCLE_SECONDS.
    let elapsed = 0
    while (choreo.state.legIndex === 0 && elapsed < 100) {
      choreo.update(0.05)
      elapsed += 0.05
    }
    expect(Math.abs(elapsed - CYCLE_SECONDS)).toBeLessThan(0.1)
    // A NaN roster collapses to a single brand rather than wrapping to NaN.
    expect(choreo.state.brandIndex).toBe(0)
  })

  it('honours custom durations end to end', () => {
    const custom = makeOptions({
      legSeconds: 1,
      gatherSeconds: 0.5,
      holdSeconds: 2,
      scatterSeconds: 0.5,
      amplitudeX: 4,
      swayY: 1,
      swayZ: 1,
    })
    const choreo = createChoreography(custom)
    let elapsed = 0
    while (choreo.state.legIndex === 0 && elapsed < 10) {
      choreo.update(0.001)
      elapsed += 0.001
    }
    expect(Math.abs(elapsed - 4)).toBeLessThan(0.01)
    const out: Point3 = { x: 0, y: 0, z: 0 }
    for (let i = 0; i <= 50; i++) {
      choreo.sampleTrail((i / 50) * 0.9, out)
      expect(Number.isFinite(out.x)).toBe(true)
      expect(Math.abs(out.x)).toBeLessThanOrEqual(4 + 1e-9)
      expect(Math.abs(out.y)).toBeLessThanOrEqual(1 + 1e-9)
      expect(Math.abs(out.z)).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('mutates one stable state object instead of allocating per frame', () => {
    const choreo = createChoreography(makeOptions())
    const first = choreo.state
    for (let i = 0; i < 100; i++) choreo.update(0.1)
    expect(choreo.state).toBe(first)
  })

  it('exposes the head through headX/headY/headZ, not the sampler scratch fields', () => {
    // Regression guard: the sampler writes x/y/z while the state carries
    // headX/headY/headZ. Passing the state itself as the sampler target compiles
    // fine and silently leaves the head at zero — which is exactly what the first
    // draft of this file did.
    const choreo = createChoreography(makeOptions())
    choreo.update(3)
    expect(choreo.state.headX).not.toBe(0)
    expect(Math.abs(choreo.state.headX)).toBeGreaterThan(1)
    expect(choreo.state).not.toHaveProperty('x')
  })
})
