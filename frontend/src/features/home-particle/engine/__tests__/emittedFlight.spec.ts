import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, PerspectiveCamera, Points, PointsMaterial, Vector3 } from 'three'
import { createEngineScratch, fillEmissionTable, paletteFor, ParticleEngine } from '../ParticleEngine'
import { writeCometFlowBasis } from '../cometFlow'
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
  const camera = new PerspectiveCamera()
  const engine = Object.assign(Object.create(ParticleEngine.prototype) as {
    integrate(step: number, time: number, delta: number): void; upload(): void
  }, {
    ...cometVisualFixture(light),
    scratch, camera, particleCount: count, choreography: { state }, geometry, tailGeometry,
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
  return { scratch, pool, state, update, tailGeometry, camera }
}

describe('rendered independent tail birth and death', () => {
  it('uploads a transparent death frame, then reuses only at the current nozzle', () => {
    const { scratch, pool, state, update } = flight()
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
    const basis = new Float64Array(9)
    writeCometFlowBasis(basis, scratch.tailTable)
    const head = [state.headX, state.headY, state.headZ]
    for (let j = 0; j < 3; j++) {
      const expected = head[j]! + basis[j]! * pool.aperture[0]! +
        basis[j + 3]! * pool.aperture[1]! + basis[j + 6]! * pool.aperture[2]!
      expect(pool.birthPosition[j]).toBe(Math.fround(expected))
      expect(pool.positions[j]).toBe(pool.birthPosition[j])
    }
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

  it('preserves birth acceleration and the same world trajectory through two different future inputs', () => {
    const a = flight(), b = flight()
    const birth = a.pool.birthPosition.slice(0, 3)
    const velocity = a.pool.birthVelocity.slice(0, 3)
    const acceleration = a.pool.birthAcceleration.slice(0, 3)
    expect(Math.hypot(...acceleration)).toBeGreaterThan(0.1)
    const bornAt = a.pool.birthTime[0]
    for (const dt of [0.17, 0.29]) {
      b.state.headX += 400; b.state.headY -= 80; b.state.headZ -= 600
      b.camera.position.set(1000 * dt, -900, 250)
      b.camera.rotation.set(dt, 0.8, 1.7)
      b.scratch.tailTable.xyz.fill(100)
      b.scratch.tailTable.vel.fill(-20)
      b.scratch.tailTable.axis.set([0, 0, 1])
      const age = a.pool.age[0]! + dt
      a.update(dt); b.update(dt)
      for (let j = 0; j < 3; j++) {
        expect(a.pool.positions[j]).toBe(Math.fround(birth[j]! + velocity[j]! * age + 0.5 * acceleration[j]! * age * age))
        expect(b.pool.positions[j]).toBe(a.pool.positions[j])
        expect(b.pool.birthPosition[j]).toBe(birth[j])
        expect(b.pool.birthVelocity[j]).toBe(velocity[j])
        expect(b.pool.birthAcceleration[j]).toBe(acceleration[j])
      }
      expect(b.pool.birthTime[0]).toBe(bornAt)
      expect(b.pool.colors.slice(0, 4)).toEqual(a.pool.colors.slice(0, 4))
    }
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
