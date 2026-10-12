import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, Points, PointsMaterial, Vector3 } from 'three'
import { createEngineScratch, fillEmissionTable, paletteFor, ParticleEngine } from '../ParticleEngine'
import { cometVisualFixture } from './cometVisualFixture'
import type { ChoreographyState } from '../types'

/** Real integration and upload; only WebGL construction is omitted. */
function flight(light = false) {
  const count = 1024
  const scratch = createEngineScratch(count, 48)
  const pool = scratch.emittedTail
  const state: ChoreographyState = {
    phase: 'travel', phaseProgress: 0.2, legIndex: 0, brandIndex: 0,
    fromX: -2.56, toX: 2.56, headX: 4, headY: 1, headZ: 0,
  }
  fillEmissionTable(scratch.tailTable, { sampleTrail(delay, out) {
    out.x = state.headX - delay
    out.y = state.headY
    out.z = state.headZ
  } }, scratch.probePoint)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(scratch.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(scratch.colors, 4))
  geometry.setAttribute('cometScale', new BufferAttribute(scratch.body.spriteScale, 1))
  const tailGeometry = new BufferGeometry()
  tailGeometry.setAttribute('position', new BufferAttribute(pool.positions, 3))
  tailGeometry.setAttribute('color', new BufferAttribute(pool.colors, 4))
  const engine = Object.assign(Object.create(ParticleEngine.prototype) as {
    integrate(step: number, time: number, delta: number): void; upload(): void
  }, {
    ...cometVisualFixture(light),
    scratch, particleCount: count, choreography: { state }, geometry, tailGeometry,
    palette: paletteFor(light), light, reducedMotion: false,
    points: new Points(geometry, new PointsMaterial({ size: paletteFor(light).pointSize })), tailPoints: new Points(tailGeometry),
    renderedPhase: 'travel', renderedHead: new Vector3(state.headX, state.headY, state.headZ), holdFade: 0,
    pointer: { active: false, lastMove: 0 },
  })
  let time = 0
  const update = (delta = 1 / 60) => {
    time += delta
    state.phaseProgress += delta / 6.5
    engine.integrate(Math.min(delta * 60, 2), time, delta)
    engine.upload()
  }
  update()
  update()
  return { scratch, pool, state, update, tailGeometry }
}

describe('rendered independent tail birth and death', () => {
  it('uploads a transparent death frame, then reuses only at the current nozzle', () => {
    const { pool, state, update } = flight()
    pool.age[0] = pool.life[0] - 0.0001
    pool.positions.set([-30, 18, 3], 0)
    update()
    expect(pool.active[0]).toBe(2)
    expect(pool.colors[3]).toBe(0)
    expect(pool.positions[0]).toBe(-30)
    const oldBirth = pool.birthTime[0]
    state.headX = 7
    for (let f = 0; f < 300 && pool.birthTime[0] === oldBirth; f++) update()
    expect(pool.birthTime[0]).toBeGreaterThan(oldBirth)
    expect(pool.age[0]).toBe(0)
    expect(pool.colors[3]).toBe(0)
    expect(Math.hypot(pool.positions[0] - 7, pool.positions[1] - 1, pool.positions[2])).toBeLessThan(0.2)
  })

  it.each([false, true])('writes lifetime transparency into the final colour attribute (light=%s)', light => {
    const { pool, update, tailGeometry } = flight(light)
    pool.age[0] = pool.life[0] * 0.05
    update(0)
    const colors = tailGeometry.getAttribute('color').array
    const earlyAlpha = colors[3]
    pool.age[0] = pool.life[0] * 0.9999
    update(0)
    expect(earlyAlpha).toBeGreaterThan(0.1)
    expect(colors[3] / earlyAlpha).toBeLessThan(0.01)
    expect(colors[0]).toBeGreaterThan(0)
  })

  it('preserves world-space velocity after a turn instead of rotating the born plume', () => {
    const { scratch, pool, update } = flight()
    const before = pool.positions.slice(0, 3)
    const velocity = pool.birthVelocity.slice(0, 3)
    scratch.tailTable.xyz.fill(100)
    scratch.tailTable.vel.fill(-20)
    scratch.tailTable.axis.fill(0)
    update(0.01)
    for (let j = 0; j < 3; j++) expect(pool.positions[j] - before[j]).toBeCloseTo(velocity[j] * 0.01, 5)
  })

  it('lets the emitted tail die in place while the separate body gathers into the logo', () => {
    const { scratch, pool, state, update } = flight()
    const birth = pool.birthPosition.slice()
    const bornAt = pool.birthTime.slice()
    state.phase = 'gather'
    state.phaseProgress = 0
    update()
    expect(pool.birthPosition).toEqual(birth)
    expect(pool.birthTime).toEqual(bornAt)
    state.phaseProgress = 1
    update(3)
    expect(pool.colors.filter((_, i) => i % 4 === 3).every(a => a === 0)).toBe(true)
    for (let i = 0; i < scratch.colors.length / 4; i++) expect(scratch.colors[i * 4 + 3]).toBe(1)
  })
})
