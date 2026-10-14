import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { createChoreography } from '../choreography'
import { createEmissionTable, fillEmissionTable } from '../ParticleEngine'
import { writeCometFlowBasis } from '../cometFlow'

const options = { brandCount: 28, amplitudeX: 2.56, swayY: 0, swayZ: 0 }

describe('world birth flow', () => {
  it.each([0, 1])('keeps leg %s oblique, right handed and continuous throughout travel', leg => {
    const choreography = createChoreography(options)
    choreography.update(leg * 12 + 0.15)
    const table = createEmissionTable(96), out = new Float64Array(9)
    const previous = new Float64Array(9)
    let samples = 0
    for (let frame = 0; frame < 360; frame++) {
      choreography.update(1 / 60)
      fillEmissionTable(table, choreography, { x: 0, y: 0, z: 0 })
      const original = [table.xyz.slice(), table.vel.slice(), table.axis.slice(), table.side1.slice(), table.side2.slice()]
      writeCometFlowBasis(out, table)
      const axis = new Vector3().fromArray(out), side1 = new Vector3().fromArray(out, 3), side2 = new Vector3().fromArray(out, 6)
      expect(Math.hypot(axis.x, axis.y)).toBeGreaterThan(0.8)
      for (const v of [axis, side1, side2]) expect(v.length()).toBeCloseTo(1, 12)
      expect(axis.dot(side1)).toBeCloseTo(0, 12)
      expect(axis.dot(side2)).toBeCloseTo(0, 12)
      expect(side1.dot(side2)).toBeCloseTo(0, 12)
      expect(axis.clone().cross(side1).distanceTo(side2)).toBeLessThan(1e-12)
      expect(Math.hypot(axis.x, axis.y)).toBeGreaterThan(0.8)
      expect(Math.abs(axis.z)).toBeGreaterThan(0.12)
      expect(Math.abs(axis.z)).toBeLessThan(0.6)
      expect(axis.x * table.axis[0]).toBeGreaterThan(0)
      if (samples++) {
        for (let j = 0; j < 9; j++) expect(Math.abs(out[j]! - previous[j]!)).toBeLessThan(0.03)
      }
      previous.set(out)
      expect([table.xyz, table.vel, table.axis, table.side1, table.side2]).toEqual(original)
    }
  })

  it('uses continuous world phase across Z boundaries with no camera or retained caller state', () => {
    const table = createEmissionTable(2), a = new Float64Array(9), b = new Float64Array(9).fill(99)
    table.axis.set([0.12, 0, -0.993]); table.vel.set([-1, 0, 8])
    let previous = new Float64Array(9)
    for (let i = 0; i < 500; i++) {
      table.xyz.set([2.56, 0, 179 + i / 100])
      writeCometFlowBasis(a, table); writeCometFlowBasis(b, table)
      expect(a).toEqual(b)
      if (i > 0) expect(Math.hypot(...a.map((v, j) => v - previous[j]!))).toBeLessThan(0.002)
      previous = a.slice()
    }
    const before = a.slice()
    table.xyz[2] += 20
    writeCometFlowBasis(a, table)
    expect(Math.hypot(...a.map((v, j) => v - before[j]!))).toBeGreaterThan(0.001)
  })
})
