import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import { createEngineScratch, type EmissionTable } from '../ParticleEngine'
import { createCometBody, EmittedTail } from '../emittedTail'
import { writeCometFlowBasis } from '../cometFlow'

const core = new Color('#abcdef'), accent = new Color('#123456')
function table(): EmissionTable {
  return {
    xyz: new Float32Array(6), vel: new Float32Array([-2, 0, 0, -2, 0, 0]),
    axis: new Float32Array([1, 0, 0, 1, 0, 0]), side1: new Float32Array([0, 1, 0, 0, 1, 0]),
    side2: new Float32Array([0, 0, 1, 0, 0, 1]), probeCount: 2, spanSeconds: 3.2,
  }
}
const step = (pool: EmittedTail, dt: number, departure: number, emit = true, basis = table(), head = [0, 0, 0], light = false) =>
  pool.update(dt, departure, emit, basis, head[0]!, head[1]!, head[2]!, core, accent, light)
const quantile = (values: number[], q: number) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!

// These are physical/attribute contracts, not an assertion of reference-image similarity.
describe('reference comet body', () => {
  it('has a long filled wedge, a finer sprite population and an enclosing sheath in all axes', () => {
    const body = createCometBody(18000)
    expect(Object.keys(body)).toEqual(['offsets', 'alpha', 'tone', 'spriteSize', 'spriteScale'])
    const ranges = [true, false].map(inner => {
      const coords: number[][] = [[], [], []]
      for (let i = 0; i < body.tone.length; i++) {
        if ((body.tone[i]! >= 0.72) !== inner) continue
        for (let j = 0; j < 3; j++) coords[j]!.push(body.offsets[i * 3 + j]!)
      }
      return coords.map(values => [quantile([...values], 0.01), quantile([...values], 0.99)])
    })
    for (let j = 0; j < 3; j++) {
      expect(ranges[1]![j]![0]).toBeLessThan(ranges[0]![j]![0]!)
      expect(ranges[1]![j]![1]).toBeGreaterThan(ranges[0]![j]![1]!)
    }
    const span = ranges[0]!.map(pair => pair[1]! - pair[0]!)
    expect(span[0]! / span[1]!).toBeGreaterThan(2.5)
    expect(span[1]! / span[2]!).toBeCloseTo(1, 1)
    expect(quantile(Array.from(body.spriteSize), 0.98)).toBeLessThan(0.9)
    expect(quantile(Array.from(body.spriteSize), 0.02)).toBeGreaterThan(0.45)
    expect(Math.max(...body.spriteSize)).toBeLessThan(1.05)
    expect(Math.max(...body.alpha)).toBeLessThan(0.7)
    expect(body.spriteScale.every(value => value === 1)).toBe(true)
    expect(Object.values(body).every(array => array.every(Number.isFinite))).toBe(true)
    const octants = new Uint32Array(8)
    for (let i = 0; i < body.tone.length; i++) {
      if (body.tone[i]! >= 0.72) continue
      const k = i * 3
      octants[(body.offsets[k]! > 0.336 ? 4 : 0) + (body.offsets[k + 1]! > 0 ? 2 : 0) + (body.offsets[k + 2]! > 0 ? 1 : 0)]!++
    }
    expect(Math.min(...octants)).toBeGreaterThan(500)
  })
})

describe('reference emitted grains', () => {
  it('reconstructs every transparent birth from its actual local aperture and the shared world basis', () => {
    for (const direction of [-1, 1]) {
      const p = new EmittedTail(24000), source = table(), flow = new Float64Array(9)
      source.axis.set([direction * 0.1, 0, -0.995])
      source.vel.set([-direction, 0, 10])
      source.xyz.set([9, 3, -12000])
      writeCometFlowBasis(flow, source)
      expect(p.birthTime.every(t => t === -1)).toBe(true)
      step(p, 0.3, 0.3, true, source, [9, 3, -12000])
      let born = 0, radius = 0
      const signs = new Uint32Array(4)
      for (let i = 0; i < p.count; i++) {
        if (!p.active[i]) continue
        born++
        const k = i * 3
        for (let j = 0; j < 3; j++) {
          const expected = [9, 3, -12000][j]! + flow[j]! * p.aperture[k]! +
            flow[j + 3]! * p.aperture[k + 1]! + flow[j + 6]! * p.aperture[k + 2]!
          expect(p.birthPosition[k + j]).toBe(Math.fround(expected))
          expect(p.positions[k + j]).toBe(p.birthPosition[k + j])
        }
        expect(p.colors[i * 4 + 3]).toBe(0)
        radius = Math.max(radius, Math.hypot(p.aperture[k + 1]!, p.aperture[k + 2]!))
        signs[(p.aperture[k + 1]! > 0 ? 2 : 0) + (p.aperture[k + 2]! > 0 ? 1 : 0)]!++
      }
      expect(born).toBeGreaterThan(2000)
      expect(radius).toBeGreaterThan(0.38)
      expect(radius).toBeLessThan(0.47)
      expect(Math.min(...signs)).toBeGreaterThan(500)
    }
  })

  it('keeps old world trajectories and colours identical when the head, basis and departure change', () => {
    const a = new EmittedTail(4000), b = new EmittedTail(4000)
    step(a, 0.1, 0.1); step(b, 0.1, 0.1)
    const changed = table()
    changed.axis.fill(-1); changed.vel.fill(999); changed.side1.fill(0); changed.side2.fill(1)
    for (let frame = 0; frame < 70; frame++) {
      step(a, 1 / 60, 0.1, false)
      step(b, 1 / 60, 100 + frame, false, changed, [999, -500, -12000])
    }
    expect(b.birthPosition).toEqual(a.birthPosition)
    expect(b.birthVelocity).toEqual(a.birthVelocity)
    expect(b.positions).toEqual(a.positions)
    expect(b.colors).toEqual(a.colors)
  })

  it.each([false, true])('uploads substantial alpha and both cold and warm grains (light=%s)', light => {
    const p = new EmittedTail(24000)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(p.positions, 3))
    geometry.setAttribute('color', new BufferAttribute(p.colors, 4))
    step(p, 0.4, 0.4, true, table(), [0, 0, 0], light)
    step(p, 0.55, 0.95, false, table(), [0, 0, 0], light)
    const colors = geometry.getAttribute('color').array
    let warm = 0, cold = 0
    const alphas: number[] = []
    for (let i = 0; i < p.count; i++) {
      if (p.active[i] !== 1) continue
      const c = i * 4
      alphas.push(colors[c + 3]!)
      if (colors[c]! > colors[c + 2]! * 2) warm++
      if (colors[c + 2]! > colors[c]! * 1.3) cold++
    }
    expect(warm / alphas.length).toBeGreaterThan(0.4)
    expect(cold / alphas.length).toBeGreaterThan(0.25)
    expect(quantile(alphas, 0.9)).toBeGreaterThan(0.3)
    expect(quantile(alphas, 0.9) / quantile(alphas, 0.1)).toBeGreaterThan(3)
    expect(geometry.getAttribute('position').array).toBe(p.positions)
    expect(geometry.getAttribute('color').itemSize).toBe(4)
    geometry.dispose()
  })

  it('forms a dense long shallow dual plume with pulse packets instead of a short smoke ball', () => {
    const p = createEngineScratch(18000, 48).emittedTail
    const births: number[] = []
    for (let f = 1; f <= 168; f++) {
      const t = f / 60
      step(p, 1 / 60, t, true, table(), [-2 * t, 0, 0])
      births.push(p.age.reduce((n, age, i) => n + (age === 0 && p.active[i] === 1 ? 1 : 0), 0))
    }
    const along: number[] = [], across: number[] = [], alphas: number[] = []
    const flow = new Float64Array(9)
    writeCometFlowBasis(flow, table())
    const halves = { cold: [0, 0], warm: [0, 0] }
    const widths = { cold: [] as number[], warm: [] as number[] }
    for (let i = 0; i < p.count; i++) {
      if (p.active[i] !== 1 || p.colors[i * 4 + 3]! < 0.035) continue
      // Remove the emitter's independently inherited translation before measuring
      // width in the birth flow. World Y/Z now contain real longitudinal travel.
      const age = p.age[i]!, k = i * 3
      const x = p.positions[k]! + 2 * p.birthTime[i]! + 0.5 * age
      const y = p.positions[k + 1]!, z = p.positions[k + 2]!
      const longitudinal = x * flow[0]! + y * flow[1]! + z * flow[2]!
      const u = x * flow[3]! + y * flow[4]! + z * flow[5]!
      const v = x * flow[6]! + y * flow[7]! + z * flow[8]!
      along.push(longitudinal)
      across.push(Math.hypot(u, v))
      alphas.push(p.colors[i * 4 + 3]!)
      if (age < 0.6 || age > 1.4) continue
      const kind = p.colors[i * 4 + 2]! > p.colors[i * 4]! ? 'cold' : 'warm'
      halves[kind][v < 0 ? 0 : 1]!++
      widths[kind].push(Math.hypot(u, v))
    }
    expect(along.length).toBeGreaterThan(18000)
    expect(quantile(along, 0.95)).toBeGreaterThan(30)
    expect(quantile(across, 0.95)).toBeLessThan(1.5)
    for (const values of Object.values(halves)) expect(Math.min(...values) / (values[0]! + values[1]!)).toBeGreaterThan(0.3)
    expect(quantile(widths.cold, 0.9)).toBeLessThan(quantile(widths.warm, 0.9) * 0.7)
    expect(Math.max(...births) / Math.min(...births)).toBeGreaterThan(1.5)
    expect(quantile(alphas, 0.5)).toBeGreaterThan(0.1)
  })

  it('retires transparently without teleporting and empties before a three second hold ends', () => {
    const p = new EmittedTail(1000)
    step(p, 0.3, 0.3)
    p.age[0] = p.life[0]! - 0.001
    const position = p.positions.slice(0, 3)
    const birth = p.birthTime[0]
    step(p, 0.01, 0.31)
    expect(p.active[0]).toBe(2)
    expect(p.colors[3]).toBe(0)
    expect(p.positions.slice(0, 3)).toEqual(position)
    expect(p.birthTime[0]).toBe(birth)
    step(p, 3, 0, false)
    expect(p.colors.filter((_, i) => i % 4 === 3).every(v => v === 0)).toBe(true)
    const old = p.birthPosition.slice()
    step(p, 1, 0, true, { ...table(), vel: new Float32Array(6) })
    expect(p.birthPosition).toEqual(old)
  })
})
