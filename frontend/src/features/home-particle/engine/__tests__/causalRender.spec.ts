import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { createEngineScratch, paletteFor, ParticleEngine } from '../ParticleEngine'
import { LEG_SECONDS, SCATTER_SECONDS } from '../constants'
import { COALESCE_END, departureSeconds } from '../flightTiming'
import type { ChoreographyState } from '../types'

const COUNT = 1024

/** Only WebGL/DOM are replaced. Exercise the production clock → table → CPU → upload chain. */
export function renderHarness(light = false, moving = true) {
  const scratch = createEngineScratch(COUNT, 48)
  const state: ChoreographyState = {
    phase: 'hold', phaseProgress: 1, legIndex: 0, brandIndex: 0,
    fromX: -2.56, toX: 2.56, headX: 2.56, headY: 0, headZ: 0,
  }
  let seconds = 0
  const choreography = {
    state,
    update() {
      seconds = departureSeconds(state.phase, state.phaseProgress, LEG_SECONDS, SCATTER_SECONDS)
      state.headX = moving ? 2.56 - seconds * 2 : 2.56
    },
    sampleTrail(delay: number, out: { x: number; y: number; z: number }) {
      out.x = moving ? 2.56 - Math.max(0, seconds - delay) * 2 : 2.56
      out.y = out.z = 0
    },
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(scratch.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(scratch.colors, 4))
  geometry.setAttribute('cometScale', new BufferAttribute(scratch.body.spriteScale, 1))
  // The pool is owned by createEngineScratch, never by the test fixture.
  const pool = Reflect.get(scratch, 'emittedTail') as {
    positions: Float32Array; colors: Float32Array; birthTime: Float64Array
    birthPosition: Float32Array; birthVelocity: Float32Array
    age: Float32Array; life: Float32Array; active: Uint8Array
  } | undefined
  const tailGeometry = new BufferGeometry()
  tailGeometry.setAttribute('position', new BufferAttribute(pool?.positions ?? new Float32Array(0), 3))
  tailGeometry.setAttribute('color', new BufferAttribute(pool?.colors ?? new Float32Array(0), 4))
  const engine = Object.assign(Object.create(ParticleEngine.prototype) as {
    advanceClock(delta: number): void
    writeEmissionTable(): void
    integrate(step: number, time: number, delta: number): void
    upload(): void
  }, {
    scratch, particleCount: COUNT, choreography, geometry, tailGeometry,
    palette: paletteFor(light), light, reducedMotion: false,
    points: new Points(geometry, new PointsMaterial({ size: paletteFor(light).pointSize })), tailPoints: new Points(tailGeometry),
    renderedPhase: 'hold', lastPhase: 'hold', holdFade: 0, tailPoint: new Float32Array(3),
    pointer: { active: false, lastMove: 0 }, width: 1440, height: 900,
    options: {}, roster: [{ slug: 'fixture' }], currentBrandSlug: 'fixture',
    brandSource: { prefetch() {} }, quality: { iconCanvasSize: 256 }, dollySeconds: 0,
  })
  for (let i = 0; i < COUNT; i++) {
    scratch.glyphTargets[i * 3] = 2.56 + Math.cos(i) * 4
    scratch.glyphTargets[i * 3 + 1] = Math.sin(i) * 4
    scratch.positions.set(scratch.glyphTargets.subarray(i * 3, i * 3 + 3), i * 3)
    scratch.colors[i * 4 + 3] = 1
  }
  let time = 0
  function update(phase: ChoreographyState['phase'], progress: number, delta = 1 / 60) {
    state.phase = phase
    state.phaseProgress = progress
    time += delta
    engine.advanceClock(delta)
    engine.writeEmissionTable()
    engine.integrate(Math.min(delta * 60, 2), time, delta)
    engine.upload()
  }
  function depart(t: number, delta = 1 / 60) {
    const scatterDeparture = SCATTER_SECONDS * (1 - COALESCE_END)
    if (t <= scatterDeparture) update('scatter', COALESCE_END + t / SCATTER_SECONDS, delta)
    else update('travel', (t - scatterDeparture) / LEG_SECONDS, delta)
  }
  return { scratch, state, engine, pool, geometry, tailGeometry, update, depart }
}

function extent(positions: ArrayLike<number>, colors: ArrayLike<number>, x: number) {
  let max = 0
  for (let i = 0; i < colors.length / 4; i++) {
    if (colors[i * 4 + 3] <= 0.01) continue
    max = Math.max(max, Math.hypot(positions[i * 3] - x, positions[i * 3 + 1], positions[i * 3 + 2]))
  }
  return max
}

describe('causal render: separate body and emitted tail', () => {
  it.each([false, true])('preserves light through gather and restores glyph coverage (light=%s)', light => {
    const h = renderHarness(light)
    h.update('travel', 0.4)
    const scale = h.geometry.getAttribute('cometScale')
    const before = Array.from(h.scratch.colors.filter((_, i) => i % 4 === 3),
      (alpha, i) => alpha * scale.getX(i) ** 2)
    const version = scale.version
    expect(Math.min(...h.scratch.body.spriteScale)).toBeGreaterThan(1)
    h.update('gather', 0)
    expect(scale.version).toBeGreaterThan(version)
    for (let i = 0; i < COUNT; i++) {
      expect(h.scratch.colors[i * 4 + 3] * scale.getX(i) ** 2).toBeCloseTo(before[i], 6)
    }
    h.update('gather', 1)
    h.update('hold', 0)
    expect(h.scratch.body.spriteScale.every(size => size === 1)).toBe(true)
    expect(h.scratch.colors.filter((_, i) => i % 4 === 3).every(alpha => alpha === 1)).toBe(true)
    expect(h.geometry.getAttribute('position').count).toBe(COUNT)
  })

  it.each([0.62, 0.85, 1])('coalesces every visible logo particle into the nucleus/coma by scatter %s', (p) => {
    const h = renderHarness(false, false)
    h.update('scatter', 0)
    h.update('scatter', p)
    expect(extent(h.geometry.getAttribute('position').array, h.geometry.getAttribute('color').array, h.state.headX)).toBeLessThan(1.15)
    expect(h.pool, 'a separately owned emission pool must exist').toBeDefined()
    expect(extent(h.tailGeometry.getAttribute('position').array, h.tailGeometry.getAttribute('color').array, h.state.headX)).toBe(0)
  })

  it('starts empty, emits at the current nucleus, and grows over 0.1 / 0.3 / 0.8 seconds', () => {
    const h = renderHarness()
    h.update('scatter', 0)
    h.depart(0)
    expect(h.pool).toBeDefined()
    expect(h.pool!.active.some(Boolean)).toBe(false)
    const lengths: number[] = []
    for (let f = 1; f <= 48; f++) {
      h.depart(f / 60)
      if (f === 6 || f === 18 || f === 48) lengths.push(extent(h.pool!.positions, h.pool!.colors, h.state.headX))
      for (let i = 0; i < h.pool!.active.length; i++) {
        if (!h.pool!.active[i]) continue
        expect(h.pool!.birthTime[i]).toBeGreaterThanOrEqual(0)
        expect(Math.hypot(h.pool!.birthPosition[i * 3] - (2.56 - h.pool!.birthTime[i] * 2), h.pool!.birthPosition[i * 3 + 1], h.pool!.birthPosition[i * 3 + 2])).toBeLessThan(0.35)
      }
    }
    expect(lengths[0]).toBeGreaterThan(0)
    expect(lengths[0]).toBeLessThan(1.5)
    expect(lengths[1]).toBeGreaterThan(lengths[0] * 1.5)
    expect(lengths[2]).toBeGreaterThan(lengths[1] * 1.5)
    expect(h.geometry.getAttribute('position').array).not.toBe(h.tailGeometry.getAttribute('position').array)
  })

  it('uses elapsed seconds, not the clamped 60-Hz spring step, for emission', () => {
    const counts: number[] = []
    for (const fps of [20, 60, 120]) {
      const h = renderHarness()
      h.update('scatter', 0)
      h.depart(0)
      for (let f = 1; f <= fps * 0.3; f++) h.depart(f / fps, 1 / fps)
      expect(h.pool).toBeDefined()
      counts.push(h.pool!.active.reduce((sum, value) => sum + value, 0))
    }
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })
})
