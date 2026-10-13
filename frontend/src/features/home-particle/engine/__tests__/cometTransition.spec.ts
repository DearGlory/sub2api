import { describe, expect, it } from 'vitest'
import { createCometBody } from '../emittedTail'
import { assignCometCore, writeCometTransition } from '../cometTransition'

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

const assignment = new Uint32Array(count)
assignCometCore(assignment, new Uint32Array(count), new Uint32Array(count),
  new Float64Array(count), new Float64Array(count), sources, body.offsets, 0, 0, 0)

function sample(phase: 'gather' | 'scatter', q: number, i: number, glyphShift = 0) {
  const k = i * 3
  const targetIndex = phase === 'scatter' ? assignment[i] * 3 : k
  const source = phase === 'gather' ? body.offsets : sources
  writeCometTransition(out, phase, q,
    head[0] + source[k], head[1] + source[k + 1], head[2] + source[k + 2],
    head[0] + sources[k] + glyphShift, head[1] + sources[k + 1], head[2] + sources[k + 2],
    head[0] + body.offsets[targetIndex], head[1] + body.offsets[targetIndex + 1], head[2] + body.offsets[targetIndex + 2],
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
  it('peels individual grains at staggered times, drifts locally, then captures into the glyph', () => {
    let detached = 0, attached = 0, drifting = 0
    for (let i = 0; i < count; i++) {
      const source = sample('gather', 0, i).slice()
      const early = sample('gather', 0.12, i).slice()
      const middle = sample('gather', 0.32, i).slice()
      const late = sample('gather', 0.9, i).slice()
      const drift = Math.hypot(early[0] - source[0], early[1] - source[1], early[2] - source[2])
      if (drift > 0.005) detached++
      else attached++
      if (Math.hypot(middle[0] - source[0], middle[1] - source[1], middle[2] - source[2]) > 0.02) drifting++
      expect(late[3]).toBeGreaterThanOrEqual(early[3])
    }
    expect(detached).toBeGreaterThan(count * 0.1)
    expect(attached).toBeGreaterThan(count * 0.1)
    expect(drifting).toBeGreaterThan(count * 0.8)
    for (let i = 0; i < count; i += 17) {
      const before = sample('gather', 0.15, i).slice()
      expect(sample('gather', 0.15, i, 100)).toEqual(before)
    }
    console.info('atomization stagger', { detached, attached, drifting })
  })

  it('maintains an open 3D grain volume, without a synchronous radial shock front', () => {
    const early = distribution('gather', 0.12)
    const midway = distribution('gather', 0.32)
    expect(early.depth).toBeGreaterThan(0.1)
    expect(midway.depth).toBeGreaterThan(early.depth)
    expect(midway.max - midway.median).toBeGreaterThan(0.3)
    expect(midway.median - distribution('gather', 0).median).toBeLessThan(1)
  })

  it('pulls outer atoms inward first, accelerating in the second half without orbital motion', () => {
    const q = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]
    const samples = q.map(value => distribution('scatter', value))
    for (let j = 1; j < samples.length; j++) {
      expect(samples[j].mean).toBeLessThan(samples[j - 1].mean)
      expect(samples[j].median).toBeLessThan(samples[j - 1].median)
      expect(samples[j].max).toBeLessThan(samples[j - 1].max)
    }
    const ratio = (samples[3].mean - samples[6].mean) / (samples[0].mean - samples[3].mean)
    expect(ratio).toBeGreaterThanOrEqual(1.8)
    let monotone = 0, outerMoved = 0, innerMoved = 0, outerCount = 0, innerCount = 0
    for (let i = 0; i < count; i++) {
      const r0 = Math.hypot(sources[i * 3], sources[i * 3 + 1], sources[i * 3 + 2])
      let previous = Infinity, valid = true
      for (let step = 0; step <= 1000; step++) {
        const p = sample('scatter', step / 1000, i)
        const radius = Math.hypot(p[0] - head[0], p[1] - head[1], p[2] - head[2])
        if (radius > previous + 1e-5) valid = false
        previous = radius
      }
      if (valid) monotone++
      const p = sample('scatter', 0.3, i)
      const moved = r0 - Math.hypot(p[0] - head[0], p[1] - head[1], p[2] - head[2])
      if (r0 > 5) { outerMoved += moved; outerCount++ }
      if (r0 < 3) { innerMoved += moved; innerCount++ }
    }
    expect(monotone).toBe(count)
    expect(new Set(assignment).size).toBe(count)
    expect(outerMoved / outerCount).toBeGreaterThan(innerMoved / innerCount)
    expect(samples[6].depth).toBeGreaterThan(samples[0].depth)
    console.info('radial infall', { samples, ratio, monotone, outerMoved: outerMoved / outerCount, innerMoved: innerMoved / innerCount })
  })

  it.each([1, 1.15])('bounds unavoidable central reassembly with the real body (scale=%s)', scale => {
    const targets = Float64Array.from(body.offsets, value => value * scale)
    const source = sources.slice()
    // Original centre particles, including an exactly zero and a near-zero source.
    source.fill(0, 0, 30)
    source[3] = 1e-12
    const map = new Uint32Array(count), sourceOrder = new Uint32Array(count), coreOrder = new Uint32Array(count)
    const sourceRadii = new Float64Array(count), coreRadii = new Float64Array(count)
    const before = source.slice(), targetBefore = targets.slice()
    const reassemblies = assignCometCore(map, sourceOrder, coreOrder, sourceRadii, coreRadii,
      source, targets, 0, 0, 0)
    expect(source).toEqual(before)
    expect(targets).toEqual(targetBefore)
    expect(new Set(map).size).toBe(count)
    let localRadius = 0, maxStep = 0, outward = 0
    for (let i = 0; i < count; i++) {
      const k = i * 3, target = map[i] * 3
      const local = sourceRadii[i] < coreRadii[map[i]]
      if (local) { outward++; localRadius = Math.max(localRadius, coreRadii[map[i]]) }
      let px = source[k], py = source[k + 1], pz = source[k + 2], previousRadius = sourceRadii[i]
      for (let j = 0; j <= 1000; j++) {
        writeCometTransition(out, 'scatter', j / 1000,
          source[k], source[k + 1], source[k + 2], 0, 0, 0,
          targets[target], targets[target + 1], targets[target + 2], 0, 0, 0, salts[i], 1, 0.2)
        const radius = Math.hypot(out[0], out[1], out[2])
        if (!local && radius > previousRadius + 1e-9) throw new Error(`outward outer particle ${i} at ${j}`)
        if (local && j <= 650 && radius > sourceRadii[i] + 1e-9) throw new Error(`early local expansion ${i}`)
        if (local && radius > coreRadii[map[i]] + 1e-9) throw new Error(`local volume overshoot ${i}`)
        maxStep = Math.max(maxStep, Math.hypot(out[0] - px, out[1] - py, out[2] - pz))
        px = out[0]; py = out[1]; pz = out[2]; previousRadius = radius
      }
      expect(Array.from(out.slice(0, 3))).toEqual(Array.from(targets.slice(target, target + 3)))
    }
    expect(outward).toBe(reassemblies)
    expect(outward).toBe(10)
    expect(localRadius).toBeLessThan(0.6)
    expect(maxStep).toBeLessThan(0.16)
    console.info('rank transport with central sources', { scale, outward, localRadius,
      localVolume: 4 / 3 * Math.PI * localRadius ** 3, maxStep, samples: count * 1000 })
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
          const targetIndex = phase === 'scatter' ? assignment[i] * 3 : k
          expect(end[axis]).toBe(head[axis] + target[targetIndex + axis])
          expect(Math.abs(sample(phase, 0.99999, i)[axis] - end[axis])).toBeLessThan(0.00001)
        }
        expect(start[3]).toBe(phase === 'gather' ? 0.025 : 1)
        expect(end[3]).toBe(phase === 'gather' ? 1 : 0.025)
      }
    }
  })
})
