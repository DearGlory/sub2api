import { describe, expect, it } from 'vitest'
import { writeCometTransition } from '../cometTransition'

const out = new Float64Array(6)
function sample(q: number, angle: number, salt: number, phase: 'gather' | 'scatter' = 'scatter') {
  writeCometTransition(out, phase, q, Math.cos(angle) * 5, Math.sin(angle) * 5, 0.1,
    3, -2, 0, Math.cos(salt * 20) * 0.8, Math.sin(salt * 20) * 0.8, salt * 0.2,
    0, 0, 0, salt, phase === 'scatter' ? 1 : 0.025, 0.025)
  return out
}

describe('event particle continuity', () => {
  it('retains mid-collapse strands and cools continuously into the exact core', () => {
    for (const phase of ['gather', 'scatter'] as const) {
      for (const salt of [0, 0.13, 0.5, 0.93, 1]) {
        let previous = sample(0, 0.7, salt, phase)[3]
        for (let j = 1; j <= 2000; j++) {
          const p = sample(j / 2000, 0.7, salt, phase)
          expect(p.every(Number.isFinite)).toBe(true)
          expect(p[3]).toBeGreaterThanOrEqual(0)
          expect(p[3]).toBeLessThanOrEqual(1)
          expect(Math.abs(p[3] - previous)).toBeLessThan(0.01)
          previous = p[3]
        }
      }
    }
    expect(sample(0.1, 0.7, 0.5, 'gather')[3]).toBeGreaterThan(0.35)
    expect(sample(0.4, 0.7, 0.5, 'gather')[3]).toBeGreaterThan(0.35)
    expect(sample(0.8, 0.7, 0.5)[3]).toBeGreaterThan(0.45)
    expect(sample(0.99, 0.7, 0.5)[3]).toBeLessThan(0.03)
  })

  it('keeps each radius monotonic and angular motion forward until within the compact docking region', () => {
    let minAngularStep = Infinity, maxStep = 0
    for (let i = 0; i < 64; i++) {
      const angle = i * 2.399963, salt = i / 64
      let p = sample(0, angle, salt).slice()
      let previousRadius = Math.hypot(p[0], p[1], p[2])
      const coreRadius = Math.hypot(0.8, salt * 0.2)
      for (let j = 1; j <= 1000; j++) {
        const next = sample(j / 1000, angle, salt)
        const radius = Math.hypot(next[0], next[1], next[2])
        expect(radius).toBeLessThanOrEqual(previousRadius + 1e-10)
        const delta = Math.atan2(next[1], next[0]) - Math.atan2(p[1], p[0])
        const angularStep = Math.atan2(Math.sin(delta), Math.cos(delta))
        if (radius > coreRadius + 1.2) {
          minAngularStep = Math.min(minAngularStep, angularStep)
          expect(angularStep).toBeGreaterThanOrEqual(-1e-10)
        }
        const step = Math.hypot(next[0] - p[0], next[1] - p[1], next[2] - p[2])
        maxStep = Math.max(maxStep, step)
        expect(step).toBeLessThan(0.16)
        p = next.slice()
        previousRadius = radius
      }
    }
    console.info('dense per-particle orbit evidence', { minAngularStep, maxStep, samples: 64000 })
  })

  it('does not pop across source direction branches or at either endpoint', () => {
    for (const angle of [Math.PI, -Math.PI, 0, 1.3, -2.6]) {
      for (let j = 0; j <= 1000; j++) {
        const q = j / 1000
        const before = sample(q, angle - 1e-7, 0.4).slice()
        const after = sample(q, angle + 1e-7, 0.4)
        expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeLessThan(0.00001)
      }
    }
    for (const q of [0, 1]) {
      const endpoint = sample(q, 0.3, 0.6).slice()
      const nearby = sample(q === 0 ? 1e-8 : 1 - 1e-8, 0.3, 0.6)
      expect(Math.hypot(nearby[0] - endpoint[0], nearby[1] - endpoint[1], nearby[2] - endpoint[2])).toBeLessThan(0.000001)
    }
  })
})
