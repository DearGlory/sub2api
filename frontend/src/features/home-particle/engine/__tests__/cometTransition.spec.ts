import { describe, expect, it } from 'vitest'
import { createCometBody } from '../emittedTail'
import { writeCometTransition } from '../cometTransition'
import { COMET_COMA_RADIUS } from '../cometVisualContract'

const count = 1024
const body = createCometBody(count)
const out = new Float64Array(6)
const head = [2.56, 0, 81] as const
const sources = new Float64Array(count * 3)
const salts = new Float64Array(count)
for (let i = 0; i < count; i++) {
  const angle = i * 2.399963229728653
  const radius = 2 + (i % 71) / 14
  sources[i * 3] = Math.cos(angle) * radius
  sources[i * 3 + 1] = Math.sin(angle) * radius
  sources[i * 3 + 2] = (i % 7 - 3) * 0.06
  salts[i] = ((Math.imul(i + 17, 0x9e3779b1) >>> 0) / 4294967296)
}

function sample(phase: 'gather' | 'scatter', q: number, i: number, glyphShift = 0) {
  const k = i * 3
  const source = phase === 'gather' ? body.offsets : sources
  writeCometTransition(out, phase, q,
    head[0] + source[k], head[1] + source[k + 1], head[2] + source[k + 2],
    head[0] + sources[k] + glyphShift, head[1] + sources[k + 1], head[2] + sources[k + 2],
    head[0] + body.offsets[k], head[1] + body.offsets[k + 1], head[2] + body.offsets[k + 2],
    head[0], head[1], head[2], salts[i], phase === 'gather' ? 0.025 : 1, 0.025)
  return out
}

function distribution(phase: 'gather' | 'scatter', q: number) {
  const radii: number[] = []
  let minZ = Infinity, maxZ = -Infinity, sum = 0
  for (let i = 0; i < count; i++) {
    const p = sample(phase, q, i)
    const r = Math.hypot(p[0] - head[0], p[1] - head[1], p[2] - head[2])
    radii.push(r)
    sum += r
    minZ = Math.min(minZ, p[2])
    maxZ = Math.max(maxZ, p[2])
    expect(p.every(Number.isFinite)).toBe(true)
    expect(p[3]).toBeGreaterThanOrEqual(0)
    expect(p[3]).toBeLessThanOrEqual(1)
  }
  radii.sort((a, b) => a - b)
  return { median: radii[count / 2], max: radii[count - 1], mean: sum / count, depth: maxZ - minZ }
}

describe('deterministic internal ejection and gravitational collapse', () => {
  it('ejects with increasing outward speed and genuine depth before target attraction', () => {
    const samples = [0, 0.05, 0.15, 0.25].map(q => distribution('gather', q))
    for (let j = 1; j < samples.length; j++) {
      expect(samples[j].median).toBeGreaterThan(samples[j - 1].median)
      expect(samples[j].max).toBeGreaterThan(samples[j - 1].max)
      expect(samples[j].depth).toBeGreaterThan(samples[j - 1].depth)
    }
    expect((samples[3].median - samples[2].median) / 0.1)
      .toBeGreaterThan((samples[2].median - samples[1].median) / 0.1 * 1.25)
    expect(samples[3].depth).toBeGreaterThan(3)
    expect(samples[3].median).toBeGreaterThan(samples[0].median + 0.8)
    for (let i = 0; i < count; i += 17) {
      const before = sample('gather', 0.15, i).slice()
      expect(sample('gather', 0.15, i, 100)).toEqual(before)
    }
    console.info('gather radial evidence', samples)
  })

  it('has outward individual radial velocity at .05/.1/.15/.25, with a broad volume instead of a shell', () => {
    const velocities: number[] = []
    for (const q of [0.05, 0.1, 0.15, 0.25]) {
      const speeds: number[] = []
      const radii: number[] = []
      for (let i = 0; i < count; i++) {
        const before = sample('gather', q - 0.0001, i).slice()
        const p = sample('gather', q, i).slice()
        const after = sample('gather', q + 0.0001, i)
        const x = p[0] - head[0], y = p[1] - head[1], z = p[2] - head[2]
        const radius = Math.hypot(x, y, z)
        const speed = ((after[0] - before[0]) * x + (after[1] - before[1]) * y + (after[2] - before[2]) * z) / radius / (0.0002 * 1.4)
        expect(speed).toBeGreaterThan(0)
        speeds.push(speed)
        radii.push(radius)
      }
      speeds.sort((a, b) => a - b)
      radii.sort((a, b) => a - b)
      velocities.push(speeds[count / 2])
      expect(radii[Math.floor(count * 0.9)] - radii[Math.floor(count * 0.1)]).toBeGreaterThan(0.8)
    }
    expect(velocities[1]).toBeGreaterThan(velocities[0])
    expect(velocities[2]).toBeGreaterThan(velocities[1])
    expect(velocities[3]).toBeGreaterThan(velocities[2])
    expect(distribution('gather', 0.1).depth).toBeGreaterThan(distribution('gather', 0).depth)
    console.info('gather median radial velocity, world units/s at .05/.1/.15/.25', velocities)
  })

  it('contracts statistical radii monotonically, with a faster second half and a tilted spiral', () => {
    const q = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]
    const samples = q.map(value => distribution('scatter', value))
    for (let j = 1; j < samples.length; j++) {
      expect(samples[j].mean).toBeLessThan(samples[j - 1].mean)
      expect(samples[j].median).toBeLessThan(samples[j - 1].median)
      expect(samples[j].max).toBeLessThan(samples[j - 1].max)
    }
    const ratio = (samples[3].mean - samples[6].mean) / (samples[0].mean - samples[3].mean)
    expect(ratio).toBeGreaterThanOrEqual(1.8)
    expect(samples[3].depth).toBeGreaterThan(samples[0].depth + 1)
    expect(samples[6].max).toBeLessThanOrEqual(COMET_COMA_RADIUS)
    console.info('scatter radial evidence', { samples, secondHalfSpeedRatio: ratio })
  })

  it('lands exactly at source and target, with no endpoint teleport or settling velocity', () => {
    for (const phase of ['gather', 'scatter'] as const) {
      for (let i = 0; i < count; i += 13) {
        const k = i * 3
        const source = phase === 'gather' ? body.offsets : sources
        const target = phase === 'gather' ? sources : body.offsets
        const start = sample(phase, 0, i).slice()
        const end = sample(phase, 1, i).slice()
        for (let axis = 0; axis < 3; axis++) {
          expect(start[axis]).toBe(head[axis] + source[k + axis])
          expect(end[axis]).toBe(head[axis] + target[k + axis])
          expect(Math.abs(sample(phase, 0.99999, i)[axis] - end[axis])).toBeLessThan(0.00001)
        }
        expect(start[3]).toBe(phase === 'gather' ? 0.025 : 1)
        expect(end[3]).toBe(phase === 'gather' ? 1 : 0.025)
      }
    }
  })
})
