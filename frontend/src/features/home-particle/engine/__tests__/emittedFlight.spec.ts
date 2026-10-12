import { describe, expect, it } from 'vitest'
import { Points } from 'three'
import {
  advanceEmittedTail,
  createEngineScratch,
  fillEmissionTable,
  paletteFor,
  ParticleEngine,
} from '../ParticleEngine'
import { HEAD_CORE_SHARE } from '../constants'
import type { ChoreographyState } from '../types'

const COUNT = 128
const FIRST_TAIL = Math.floor(COUNT * HEAD_CORE_SHARE)

/** Exercise the real CPU update without constructing a WebGL renderer. */
function flight(light = false) {
  const scratch = createEngineScratch(COUNT, 24)
  fillEmissionTable(scratch.tailTable, {
    sampleTrail(delay, out) {
      out.x = 4 - delay
      out.y = 1
      out.z = 0
    },
  }, { x: 0, y: 0, z: 0 })
  const state: ChoreographyState = {
    phase: 'travel', phaseProgress: 0.5, legIndex: 0, brandIndex: 0,
    fromX: -2.56, toX: 2.56, headX: 4, headY: 1, headZ: 0,
  }
  const engine = Object.assign(Object.create(ParticleEngine.prototype) as {
    integrate(step: number, time: number): void
  }, {
    scratch, particleCount: COUNT, choreography: { state },
    palette: paletteFor(light), light, reducedMotion: false,
    points: new Points(), tailPoint: new Float32Array(3),
    renderedPhase: 'travel', holdFade: 0,
    pointer: { active: false, lastMove: 0 },
  })
  return { scratch, engine, state }
}

describe('rendered tail birth and death', () => {
  it('recycles the rendered position at the nozzle instead of brightening at the old tail tip', () => {
    const { scratch: s, engine } = flight()
    const i = FIRST_TAIL + 1
    const k = i * 3
    s.tailAge[i] = s.tailLife[i] - 0.0001
    s.positions.set([-30, 18, 3], k)
    s.velocities.set([-8, 3, 2], k)
    s.pointerOffset.set([9, 4, 2], k)

    engine.integrate(1, 1)

    expect(s.tailAge[i]).toBeLessThan(0.02)
    expect(s.colors[i * 4 + 3]).toBeGreaterThan(0.9)
    expect(Math.hypot(s.positions[k] - 4, s.positions[k + 1] - 1, s.positions[k + 2])).toBeLessThan(1.3)
    expect(Array.from(s.velocities.subarray(k, k + 3))).toEqual([0, 0, 0])
  })

  it.each([false, true])('writes lifetime transparency into the actual colour buffer (light=%s)', (light) => {
    const { scratch: s, engine } = flight(light)
    const i = FIRST_TAIL + 1
    s.tailAge[i] = s.tailLife[i] * 0.05
    engine.integrate(0, 1)
    const earlyAlpha = s.colors[i * 4 + 3]

    s.tailAge[i] = s.tailLife[i] * 0.9999
    engine.integrate(0, 1)
    const endAlpha = s.colors[i * 4 + 3]

    expect(earlyAlpha).toBeGreaterThan(0.9)
    expect(endAlpha / earlyAlpha).toBeLessThan(0.01)
    expect(s.colors[i * 4]).toBeGreaterThan(0) // Black RGB is still visible on white.
  })

  it('keeps an emitted trajectory when the head turns or its path is retuned', () => {
    const { scratch: s } = flight()
    const i = FIRST_TAIL + 1
    s.tailAge[i] = 0.1
    const a = new Float32Array(3)
    const b = new Float32Array(3)
    advanceEmittedTail(s, i, 0, a)
    const velocity = s.tailBirthVelocity.slice(i * 3, i * 3 + 3)
    s.tailTable.xyz.fill(100)
    s.tailTable.vel.fill(-20)
    s.tailTable.axis.fill(0)
    advanceEmittedTail(s, i, 0.01, b)
    for (let j = 0; j < 3; j++) {
      expect(b[j] - a[j]).toBeCloseTo(velocity[j] * 0.01, 5)
    }
  })

  it('does not recycle visible particles while gathering a glyph', () => {
    const { scratch: s, engine, state } = flight()
    engine.integrate(1, 1)
    const i = FIRST_TAIL + 1
    s.tailAge[i] = s.tailLife[i] - 0.0001
    const age = s.tailAge[i]
    const before = s.positions.slice()
    state.phase = 'gather'
    state.phaseProgress = 0
    engine.integrate(1, 1.02)
    expect(s.tailAge[i]).toBe(age)
    expect(s.positions).toEqual(before)

    state.phaseProgress = 1
    engine.integrate(1, 2.4)
    for (let j = 0; j < COUNT; j++) expect(s.colors[j * 4 + 3]).toBe(1)
  })
})
