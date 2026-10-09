import { describe, expect, it } from 'vitest'

import {
  createEngineScratch,
  followSpeedFor,
  glyphMixFor,
} from '../ParticleEngine'
import {
  BRANDS,
  HEAD_CORE_SHARE,
  POINTER_RADIUS,
  TAIL_SECONDS,
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

  it('gives every particle a non-zero tail radius and swirl, so nothing is degenerate', () => {
    for (let i = 0; i < COUNT; i++) {
      expect(scratch.tailRadius[i]).toBeGreaterThan(0)
      expect(scratch.tailSpin[i]).toBeGreaterThan(0)
    }
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
