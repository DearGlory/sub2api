import { describe, expect, it } from 'vitest'

import {
  accumulateArcLength,
  createEngineScratch,
  followSpeedFor,
  glyphMixFor,
  resampleByArcLength,
} from '../ParticleEngine'
import {
  BRANDS,
  HEAD_CORE_SHARE,
  POINTER_RADIUS,
  TAIL_LENGTH,
  TAIL_PROBE_COUNT,
  TAIL_RADIUS,
  TAIL_SECONDS,
  TAIL_SPREAD,
} from '../constants'

/**
 * The engine owns a WebGL context, and jsdom does not have one — so a test that
 * merely constructed it would either fail, or (worse) pass by falling into the
 * shell's catch block, which is green while asserting nothing.
 *
 * This file therefore pins the logic that is real without a GPU. The things that
 * need a context — the draw call, the frame pacing, the heap, whether the comet
 * actually moves — are measured by `tools/visual-acceptance.mjs` against real
 * Chrome, because a stubbed renderer here would only be testing the stub.
 */

const COUNT = 512
const TAIL_SAMPLES = 32

describe('createEngineScratch', () => {
  const scratch = createEngineScratch(COUNT, TAIL_SAMPLES)

  it('allocates every buffer the frame loop needs, at the right length', () => {
    expect(scratch.positions.length).toBe(COUNT * 3)
    expect(scratch.velocities.length).toBe(COUNT * 3)
    expect(scratch.colors.length).toBe(COUNT * 3)
    expect(scratch.glyphTargets.length).toBe(COUNT * 3)
    expect(scratch.glyphStrokeDepth.length).toBe(COUNT)
    expect(scratch.tailT.length).toBe(COUNT)
    expect(scratch.tailLut.length).toBe(TAIL_SAMPLES * 3)
    expect(scratch.iconOrbitOffsets.length).toBe(COUNT * 3)
  })

  it('starts every particle somewhere finite, so frame one cannot render NaN', () => {
    for (const buf of [scratch.positions, scratch.velocities, scratch.colors]) {
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i]), `non-finite at ${i}: ${buf[i]}`).toBe(true)
      }
    }
  })

  it('places every particle on the tail axis, inside [0, 1]', () => {
    for (let i = 0; i < COUNT; i++) {
      expect(scratch.tailT[i]).toBeGreaterThanOrEqual(0)
      expect(scratch.tailT[i]).toBeLessThanOrEqual(1)
    }
  })

  it('packs a head core that sits exactly at the head', () => {
    const coreCount = Math.floor(COUNT * HEAD_CORE_SHARE)
    expect(coreCount).toBeGreaterThan(0)
    for (let i = 0; i < coreCount; i++) {
      // The core is what makes the head a bright concentration instead of a
      // uniform tube, so a stray value here is a visible defect.
      expect(scratch.tailT[i]).toBe(0)
    }
  })

  it('spreads the tail densely enough that it cannot band', () => {
    // Low-discrepancy spacing: every non-core particle must land on its own value,
    // or the tail shows bands where two particles share a slot. The core particles
    // are all exactly 0 by design, so they are excluded rather than counted.
    const coreCount = Math.floor(COUNT * HEAD_CORE_SHARE)
    const tailOnly = Array.from(scratch.tailT).slice(coreCount)
    const distinct = new Set(tailOnly.map((v) => v.toFixed(4))).size
    expect(distinct).toBe(tailOnly.length)
  })

  it('keeps the head denser than the tip, which is what a comet looks like', () => {
    const coreCount = Math.floor(COUNT * HEAD_CORE_SHARE)
    const tailOnly = Array.from(scratch.tailT).slice(coreCount)
    const near = tailOnly.filter((t) => t < 0.5).length
    const far = tailOnly.filter((t) => t >= 0.5).length
    // t = u^1.35 with u uniform, so the near half must hold more than the far half.
    expect(near).toBeGreaterThan(far)
  })

  it('hashes a decorrelated roll, so no two attributes move together', () => {
    // The position roll is golden-ratio (banding-free by construction); the other
    // four must not be, or the tail renders as a helix — which is exactly the bug
    // this replaced. Correlating the raw sequences is the cheapest way to see it.
    const n = 4000
    const s = createEngineScratch(n, 16)
    const t: number[] = []
    const r: number[] = []
    for (let i = 0; i < n; i++) {
      t.push(s.tailT[i])
      r.push(s.tailRadius[i])
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const mt = mean(t)
    const mr = mean(r)
    let cov = 0
    let vt = 0
    let vr = 0
    for (let i = 0; i < n; i++) {
      const dt = t[i] - mt
      const dr = r[i] - mr
      cov += dt * dr
      vt += dt * dt
      vr += dr * dr
    }
    const corr = cov / Math.sqrt(vt * vr)
    // Independent rolls sit near 0; the golden-ratio version was strongly ordered.
    expect(Math.abs(corr)).toBeLessThan(0.12)
  })

  it('gives every particle a non-degenerate swirl and a radius inside the cone', () => {
    for (let i = 0; i < COUNT; i++) {
      expect(scratch.tailSpin[i]).toBeGreaterThan(0)
      // The radius is a fraction of the cone's half-width, so it must stay inside
      // [0, 1] — a value above 1 would push particles outside the cone the taper
      // describes, and a shell (a narrow band of radii) is what made the tail read
      // as concentric ring outlines instead of a plume.
      expect(scratch.tailRadius[i]).toBeGreaterThanOrEqual(0)
      expect(scratch.tailRadius[i]).toBeLessThanOrEqual(1)
    }
  })

  it('fills the cone instead of shelling it, so the tail reads as a plume', () => {
    // A shell would put nearly every radius near 1. Filling puts most of the mass
    // near the axis, which is what gives the tail a core.
    const mean = Array.from(scratch.tailRadius).reduce((a, b) => a + b, 0) / COUNT
    expect(mean).toBeLessThan(0.5)
    // ...but a meaningful share must still sit away from the axis, or the tail has
    // no visible width at all.
    const outer = Array.from(scratch.tailRadius).filter((r) => r > 0.6).length
    expect(outer).toBeGreaterThan(COUNT * 0.1)
  })

  it('decorrelates the per-particle attributes from the position along the tail', () => {
    // This is the bug that shipped once: every attribute was derived from the same
    // golden-ratio sequence, so radius, angle and spin were all functions of `t`
    // and the tail rendered as a machined helix. Sorted by `t`, the radius must
    // look like noise rather than a ramp.
    const coreCount = Math.floor(COUNT * HEAD_CORE_SHARE)
    const order = Array.from({ length: COUNT - coreCount }, (_, k) => k + coreCount)
    order.sort((a, b) => scratch.tailT[a] - scratch.tailT[b])

    const radii = order.map((i) => scratch.tailRadius[i])
    // Split the sorted order in half and compare means: a correlated attribute
    // would make these differ sharply, noise makes them close.
    const half = Math.floor(radii.length / 2)
    const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const early = meanOf(radii.slice(0, half))
    const late = meanOf(radii.slice(half))
    expect(Math.abs(early - late)).toBeLessThan(0.12)

    // And it must not be a monotone ramp in the sorted order either.
    let ascents = 0
    for (let k = 1; k < radii.length; k++) if (radii[k] > radii[k - 1]) ascents++
    const ascentRatio = ascents / (radii.length - 1)
    expect(ascentRatio).toBeGreaterThan(0.35)
    expect(ascentRatio).toBeLessThan(0.65)
  })

  it('wires the pointer field to the frozen radius constant', () => {
    expect(scratch.pointerField.radius).toBe(POINTER_RADIUS)
    expect(scratch.pointerField.radiusSq).toBe(POINTER_RADIUS * POINTER_RADIUS)
  })

  it('starts with the hold pose fully faded out', () => {
    // A non-zero toneScale at frame one would shade a comet as if it were a glyph.
    expect(scratch.iconHoldPose.toneScale).toBe(0)
    expect(scratch.iconHoldPose.rotationX).toBe(0)
    expect(scratch.iconHoldPose.rotationY).toBe(0)
    expect(scratch.iconHoldPose.rotationZ).toBe(0)
  })

  it('keeps the tail lookup table in step with the sample count', () => {
    expect(scratch.tailLut.length).toBe(TAIL_SAMPLES * 3)
    // A non-positive TAIL_SECONDS collapses every tail sample onto the head.
    expect(TAIL_SECONDS).toBeGreaterThan(0)
  })
})

describe('glyphMixFor', () => {
  it('is a pure comet while travelling', () => {
    expect(glyphMixFor('travel', 0)).toBe(0)
    expect(glyphMixFor('travel', 0.5)).toBe(0)
    expect(glyphMixFor('travel', 1)).toBe(0)
  })

  it('is a fully formed glyph throughout the hold', () => {
    expect(glyphMixFor('hold', 0)).toBe(1)
    expect(glyphMixFor('hold', 0.5)).toBe(1)
    expect(glyphMixFor('hold', 1)).toBe(1)
  })

  it('rises monotonically through the gather and ends fully formed', () => {
    let previous = -1
    for (let step = 0; step <= 20; step++) {
      const mix = glyphMixFor('gather', step / 20)
      expect(mix).toBeGreaterThanOrEqual(previous)
      previous = mix
    }
    expect(glyphMixFor('gather', 0)).toBeCloseTo(0, 6)
    expect(glyphMixFor('gather', 1)).toBeCloseTo(1, 6)
  })

  it('falls monotonically through the scatter and ends a pure comet', () => {
    let previous = 2
    for (let step = 0; step <= 20; step++) {
      const mix = glyphMixFor('scatter', step / 20)
      expect(mix).toBeLessThanOrEqual(previous)
      previous = mix
    }
    expect(glyphMixFor('scatter', 0)).toBeCloseTo(1, 6)
    expect(glyphMixFor('scatter', 1)).toBeCloseTo(0, 6)
  })

  it('hands over continuously at every phase boundary', () => {
    // gather(1) -> hold(0), hold(1) -> scatter(0) and scatter(1) -> travel(0) must
    // agree, or the shape jumps at the seam.
    expect(glyphMixFor('gather', 1)).toBeCloseTo(glyphMixFor('hold', 0), 6)
    expect(glyphMixFor('hold', 1)).toBeCloseTo(glyphMixFor('scatter', 0), 6)
    expect(glyphMixFor('scatter', 1)).toBeCloseTo(glyphMixFor('travel', 0), 6)
  })

  it('clamps out-of-range progress instead of extrapolating', () => {
    expect(glyphMixFor('gather', -5)).toBe(0)
    expect(glyphMixFor('gather', 5)).toBe(1)
    expect(glyphMixFor('scatter', -5)).toBe(1)
    expect(glyphMixFor('scatter', 5)).toBe(0)
  })
})

describe('followSpeedFor', () => {
  it('holds the glyph with the stiffest spring, so it reads as solid', () => {
    expect(followSpeedFor('hold')).toBeGreaterThan(followSpeedFor('travel'))
    expect(followSpeedFor('hold')).toBeGreaterThan(followSpeedFor('scatter'))
  })

  it('travels with the loosest spring, so the comet streams rather than snaps', () => {
    expect(followSpeedFor('travel')).toBeLessThan(followSpeedFor('gather'))
    expect(followSpeedFor('travel')).toBeLessThan(followSpeedFor('hold'))
  })

  it('returns a finite positive step below 1 for every phase', () => {
    for (const phase of ['travel', 'gather', 'hold', 'scatter'] as const) {
      const value = followSpeedFor(phase)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
      // A step of 1 or more would jump straight to the target and oscillate.
      expect(value).toBeLessThan(1)
    }
  })
})

describe('accumulateArcLength', () => {
  it('is zero at the start and strictly increasing along a real path', () => {
    const points = new Float32Array(TAIL_PROBE_COUNT * 3)
    for (let i = 0; i < TAIL_PROBE_COUNT; i++) {
      points[i * 3] = i * 0.5
      points[i * 3 + 1] = Math.sin(i * 0.2)
      points[i * 3 + 2] = 0
    }
    const arc = new Float32Array(TAIL_PROBE_COUNT)
    const total = accumulateArcLength(points, TAIL_PROBE_COUNT, arc)

    expect(arc[0]).toBe(0)
    for (let i = 1; i < TAIL_PROBE_COUNT; i++) {
      expect(arc[i]).toBeGreaterThan(arc[i - 1])
    }
    expect(arc[TAIL_PROBE_COUNT - 1]).toBeCloseTo(total, 5)
    // A path whose samples advance in x must be at least as long as its extent.
    expect(total).toBeGreaterThan(TAIL_PROBE_COUNT * 0.5 - 1)
  })

  it('reports zero for a stationary path, which is what a held glyph is', () => {
    const points = new Float32Array(TAIL_PROBE_COUNT * 3)
    for (let i = 0; i < TAIL_PROBE_COUNT; i++) {
      points[i * 3] = 3.5
      points[i * 3 + 1] = -1.25
    }
    const arc = new Float32Array(TAIL_PROBE_COUNT)
    const total = accumulateArcLength(points, TAIL_PROBE_COUNT, arc)
    expect(total).toBe(0)
    expect(arc[TAIL_PROBE_COUNT - 1]).toBe(0)
  })
})

describe('resampleByArcLength', () => {
  /** A straight path along x, so expected positions are trivial to state. */
  function straightPath(length: number): {
    points: Float32Array
    arc: Float32Array
    total: number
  } {
    const points = new Float32Array(TAIL_PROBE_COUNT * 3)
    for (let i = 0; i < TAIL_PROBE_COUNT; i++) {
      points[i * 3] = (i / (TAIL_PROBE_COUNT - 1)) * length
    }
    const arc = new Float32Array(TAIL_PROBE_COUNT)
    const total = accumulateArcLength(points, TAIL_PROBE_COUNT, arc)
    return { points, arc, total }
  }

  it('places samples at even spacing, which is the whole point of the pass', () => {
    const { points, arc } = straightPath(20)
    const out = new Float32Array(33 * 3)
    resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, 33, TAIL_LENGTH)

    // Evenly spaced means uniform gaps along x for a straight path.
    const gaps: number[] = []
    for (let k = 1; k < 33; k++) gaps.push(out[k * 3] - out[(k - 1) * 3])
    const first = gaps[0]
    for (const gap of gaps) expect(gap).toBeCloseTo(first, 4)
    // ...and the total span is TAIL_LENGTH, not the path's own length.
    expect(out[32 * 3] - out[0]).toBeCloseTo(TAIL_LENGTH, 4)
  })

  it('returns the spanned length, capped at the path when the path is shorter', () => {
    const short = straightPath(4)
    const out = new Float32Array(17 * 3)
    const reach = resampleByArcLength(short.points, short.arc, TAIL_PROBE_COUNT, out, 17, TAIL_LENGTH)
    // A 4-unit path cannot span a 13-unit tail.
    expect(reach).toBeCloseTo(4, 4)
    expect(out[16 * 3] - out[0]).toBeCloseTo(4, 4)
  })

  it('collapses a stationary path onto one point instead of leaving a stale tail', () => {
    const points = new Float32Array(TAIL_PROBE_COUNT * 3)
    for (let i = 0; i < TAIL_PROBE_COUNT; i++) {
      points[i * 3] = 7
      points[i * 3 + 1] = -2
      points[i * 3 + 2] = 1
    }
    const arc = new Float32Array(TAIL_PROBE_COUNT)
    accumulateArcLength(points, TAIL_PROBE_COUNT, arc)
    const out = new Float32Array(24 * 3)
    out.fill(999) // poison, so a no-op would be visible

    const reach = resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, 24, TAIL_LENGTH)

    expect(reach).toBe(0)
    for (let k = 0; k < 24; k++) {
      expect(out[k * 3]).toBe(7)
      expect(out[k * 3 + 1]).toBe(-2)
      expect(out[k * 3 + 2]).toBe(1)
    }
  })

  it('starts exactly at the head, so the tail is attached to the comet', () => {
    const { points, arc } = straightPath(20)
    const out = new Float32Array(40 * 3)
    resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, 40, TAIL_LENGTH)
    // Sample 0 is zero distance along the path, which is the head itself.
    expect(out[0]).toBeCloseTo(points[0], 5)
    expect(out[1]).toBeCloseTo(points[1], 5)
    expect(out[2]).toBeCloseTo(points[2], 5)
  })

  it('never writes a non-finite value, for any sample count a profile can ask for', () => {
    const { points, arc } = straightPath(20)
    for (const n of [1, 2, 3, 8, 48, 96, 2000]) {
      const out = new Float32Array(n * 3)
      resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, n, TAIL_LENGTH)
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i]), `n=${n} index=${i}`).toBe(true)
      }
    }
  })

  it('degrades safely on degenerate arguments rather than throwing', () => {
    const { points, arc } = straightPath(20)
    const out = new Float32Array(9 * 3)
    // A probe count below 2 has no path at all, and a sample count of 0 has nothing
    // to fill. Both are reachable through a misconfigured profile, so both must
    // return rather than throw or write out of bounds.
    expect(() => resampleByArcLength(points, arc, 1, out, 9, TAIL_LENGTH)).not.toThrow()
    expect(resampleByArcLength(points, arc, 1, out, 9, TAIL_LENGTH)).toBe(0)
    expect(() =>
      resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, 0, TAIL_LENGTH)
    ).not.toThrow()
    expect(resampleByArcLength(points, arc, TAIL_PROBE_COUNT, out, 0, TAIL_LENGTH)).toBe(0)
  })
})

describe('the tail is shaped like a comet, not a blob', () => {
  /**
   * The measurement that decided this file's constants.
   *
   * The first version of the tail was laid out at uniform *time*, and because the
   * head eases into each extreme the tail stretched and collapsed with the head's
   * speed. On screen it read as concentric rings rather than a streak. These two
   * assertions pin the property that was wrong, in the units that were wrong, so a
   * future retune cannot silently bring it back.
   */
  it('is markedly longer than it is wide', () => {
    const tipRadius = TAIL_RADIUS + TAIL_SPREAD * TAIL_LENGTH
    const aspect = TAIL_LENGTH / (2 * tipRadius)
    // Below ~3:1 the eye stops reading a streak and starts reading a cloud.
    expect(aspect).toBeGreaterThan(3)
  })

  it('keeps the head far denser than the tip, as a comet head is', () => {
    // The radius tapers linearly with distance along the tail, so the cross-section
    // at the head is a small fraction of the tip's — that ratio is what makes the
    // head read as a bright core.
    const headRadius = TAIL_RADIUS
    const tipRadius = TAIL_RADIUS + TAIL_SPREAD * TAIL_LENGTH
    expect(headRadius / tipRadius).toBeLessThan(0.3)
  })

  it('spans a distance that leaves the glyph room to be seen at the extreme', () => {
    // The glyph's own box is ~12.6 units across. A tail longer than the leg would
    // still be crossing the frame while the shape tries to form.
    expect(TAIL_LENGTH).toBeLessThan(18)
    expect(TAIL_LENGTH).toBeGreaterThan(8)
  })

  it('samples the past often enough to integrate length accurately', () => {
    // The arc-length pass walks TAIL_SECONDS at TAIL_PROBE_COUNT points; too few
    // and the accumulated length underestimates the path, which shortens the tail.
    expect(TAIL_PROBE_COUNT).toBeGreaterThanOrEqual(64)
    expect(TAIL_SECONDS / (TAIL_PROBE_COUNT - 1)).toBeLessThan(0.05)
  })
})

describe('the brand roster', () => {
  it('has the 28 logos the user asked for, with unique slugs', () => {
    expect(BRANDS.length).toBe(28)
    const slugs = BRANDS.map((b) => b.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('includes every vendor the user named', () => {
    const slugs = new Set(BRANDS.map((b) => b.slug))
    for (const required of [
      'openai',
      'anthropic',
      'gemini',
      'grok',
      'deepseek',
      'zai',
      'kimi',
      'minimax',
      'xiaomimimo',
      'qwen',
      'bytedance',
      'meta',
    ]) {
      expect(slugs.has(required), `missing ${required}`).toBe(true)
    }
  })

  it('gives every brand a label to show and a slug that maps to an asset', () => {
    for (const brand of BRANDS) {
      expect(brand.label.length).toBeGreaterThan(0)
      expect(brand.slug).toMatch(/^[a-z0-9]+$/)
    }
  })
})
