import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { createChoreography, sampleHeadPosition } from '../choreography'
import { cameraTravelAt, glyphStopZ, sampleSpaceMotion } from '../spaceMotion'
import { SPACE_CAMERA_SPEED, SPACE_CAPTURE_TOLERANCE } from '../spaceMotionContract'
import type { SpaceDerivative, SpacePoint } from '../spaceMotionContract'
import { COALESCE_END } from '../flightTiming'
import type { ChoreographyOptions, CometPhase } from '../types'

const options: ChoreographyOptions = {
  brandCount: 28, amplitudeX: 2.56, swayY: 1.6, swayZ: 2.2,
  legSeconds: 6.5, gatherSeconds: 1.4, holdSeconds: 3, scatterSeconds: 1.1,
}
const cycle = options.legSeconds + options.gatherSeconds + options.holdSeconds + options.scatterSeconds
const lead = options.scatterSeconds * (1 - COALESCE_END)
const duration = options.legSeconds + lead
const axes = ['x', 'y', 'z'] as const
const sample = (leg: number, phase: CometPhase, p: number, derivative: SpaceDerivative = 0) =>
  sampleSpaceMotion(leg, phase, p, options, { x: NaN, y: NaN, z: NaN }, derivative)
const flight = (leg: number, elapsed: number, derivative: SpaceDerivative = 0) => elapsed < lead
  ? sample(leg - 1, 'scatter', COALESCE_END + elapsed / options.scatterSeconds, derivative)
  : sample(leg, 'travel', (elapsed - lead) / options.legSeconds, derivative)
const norm = (p: SpacePoint) => Math.hypot(p.x, p.y, p.z)

describe('world-space pursuit contract', () => {
  it('freezes the same world X/Z throughout gather, hold and early scatter', () => {
    for (let leg = 0; leg < 4; leg++) {
      const anchor = { x: leg % 2 === 0 ? 2.56 : -2.56, y: 0, z: 1.35 * (leg * cycle + 6.5) }
      expect(sample(leg, 'travel', 1)).toEqual(anchor)
      for (const phase of ['gather', 'hold', 'scatter'] as const) {
        for (const p of [0, 0.2, COALESCE_END, ...(phase === 'scatter' ? [] : [0.8, 1])]) {
          expect(sample(leg, phase, p)).toEqual(anchor)
          expect(norm(sample(leg, phase, p, 1))).toBe(0)
          expect(norm(sample(leg, phase, p, 2))).toBe(0)
        }
      }
    }
  })

  it('flies four complete legs with one monotone X/Z progress and synchronous rest', () => {
    for (let leg = 0; leg < 4; leg++) {
      const direction = leg % 2 === 0 ? 1 : -1
      const startZ = 1.35 * ((leg - 1) * cycle + 6.5)
      const deltaZ = 1.35 * cycle
      let previous = flight(leg, 0)
      expect(previous).toEqual({ x: -direction * 2.56, y: 0, z: startZ })
      for (let i = 1; i <= 1000; i++) {
        const p = flight(leg, duration * i / 1000)
        const v = flight(leg, duration * i / 1000, 1)
        expect(direction * (p.x - previous.x)).toBeGreaterThan(0)
        expect(p.z - previous.z).toBeGreaterThan(0)
        expect(p.y).toBe(0)
        expect((p.x + direction * 2.56) / (direction * 5.12)).toBeCloseTo((p.z - startZ) / deltaZ, 12)
        expect(v.x === 0).toBe(v.z === 0)
        if (i < 1000) {
          expect(v.x * direction).toBeGreaterThan(0)
          expect(v.z).toBeGreaterThan(0)
          expect(v.x / (direction * 5.12)).toBeCloseTo(v.z / deltaZ, 12)
        }
        previous = p
      }
      expect(norm(flight(leg, 0, 1))).toBe(0)
      expect(norm(flight(leg, duration, 1))).toBe(0)
      expect(norm(flight(leg, 0, 2))).toBe(0)
      expect(norm(flight(leg, duration, 2))).toBe(0)
    }
  })

  it('is C1/C2 on both sides of .62 and every phase seam, including the initial frame', () => {
    const h = 1e-5
    for (let leg = -1; leg < 4; leg++) {
      const seams = [
        (s: number, d: SpaceDerivative) => sample(leg, 'scatter', COALESCE_END + s / 1.1, d),
        (s: number, d: SpaceDerivative) => s < 0 ? sample(leg, 'scatter', 1 + s / 1.1, d) : sample(leg + 1, 'travel', s / 6.5, d),
        (s: number, d: SpaceDerivative) => s < 0 ? sample(leg, 'travel', 1 + s / 6.5, d) : sample(leg, 'gather', s / 1.4, d),
        (s: number, d: SpaceDerivative) => s < 0 ? sample(leg, 'gather', 1 + s / 1.4, d) : sample(leg, 'hold', s / 3, d),
        (s: number, d: SpaceDerivative) => s < 0 ? sample(leg, 'hold', 1 + s / 3, d) : sample(leg, 'scatter', s / 1.1, d),
      ]
      for (const at of seams) {
        for (const d of [0, 1, 2] as const) {
          const before = at(-h, d)
          const after = at(h, d)
          for (const axis of axes) expect(Math.abs(after[axis] - before[axis])).toBeLessThan(0.0001)
        }
      }
      expect(sample(leg, 'scatter', 1)).toEqual(sample(leg + 1, 'travel', 0))
    }
    const opening = createChoreography(options).state
    expect({ x: opening.headX, y: opening.headY, z: opening.headZ }).toEqual(sample(-1, 'scatter', 1))
    expect(norm(sample(0, 'travel', 0, 1))).toBeGreaterThan(0)
  })

  it('reaches the target gap exactly and bounds the preceding smooth capture minimum', () => {
    const fitGap = 16.3727
    let minGap = Infinity
    let minElapsed = 0
    for (let leg = 0; leg < 4; leg++) {
      for (let i = 0; i <= 20000; i++) {
        const elapsed = duration * i / 20000
        const absolute = leg * cycle - lead + elapsed
        // Negative prehistory also has an analytic camera position.
        const gap = fitGap + SPACE_CAMERA_SPEED * absolute - flight(leg, elapsed).z
        if (gap < minGap) { minGap = gap; minElapsed = elapsed }
      }
      const arrivalTime = leg * cycle + options.legSeconds
      expect(fitGap + cameraTravelAt(arrivalTime) - sample(leg, 'travel', 1).z).toBeCloseTo(fitGap, 12)
    }
    // The capture minimum occurs when the decelerating head matches camera speed.
    let lo = duration - 0.12
    let hi = duration
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (flight(0, mid, 1).z > SPACE_CAMERA_SPEED) lo = mid
      else hi = mid
    }
    const minimumTime = (lo + hi) / 2
    const exactMinGap = fitGap + SPACE_CAMERA_SPEED * (minimumTime - lead) - flight(0, minimumTime).z
    expect(flight(0, minimumTime, 1).z).toBeCloseTo(SPACE_CAMERA_SPEED, 10)
    expect(exactMinGap).toBeLessThanOrEqual(minGap + 1e-12)
    expect(exactMinGap).toBeGreaterThanOrEqual(fitGap - SPACE_CAPTURE_TOLERANCE)
    expect(minGap).toBeLessThan(fitGap)
    console.info('capture metrics', {
      fitGap, minGap, minElapsed, exactMinGap, undershoot: fitGap - exactMinGap,
      minimumTime, secondsBeforeStop: duration - minimumTime, duration,
      departureGap: fitGap + SPACE_CAMERA_SPEED * (cycle - duration),
    })
  })

  it('camera starts at zero and grows linearly across 150/152.2 and many cycles', () => {
    const times = [0, 0.01, 6.5, 12, 149.99, 150, 150.01, 152.19, 152.2, 152.21, 336, 3600, 1e6]
    expect(cameraTravelAt(0)).toBe(0)
    for (let i = 1; i < times.length; i++) {
      expect(cameraTravelAt(times[i])).toBeGreaterThan(cameraTravelAt(times[i - 1]))
      expect(cameraTravelAt(times[i])).toBe(SPACE_CAMERA_SPEED * times[i])
    }
    console.info('camera metrics', times.map(t => [t, cameraTravelAt(t)]))
  })

  it('projects a fixed world logo smaller after a full three-second hold', () => {
    const fitGap = 16.3727
    const subjectZ = -6
    const holdStart = 6.5 + 1.4
    const anchor = sample(0, 'hold', 0)
    expect(sample(0, 'hold', 1)).toEqual(anchor)
    const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 1000)
    const projectedWidth = (t: number) => {
      camera.position.z = subjectZ + fitGap + cameraTravelAt(t)
      camera.updateMatrixWorld(true)
      const left = new Vector3(anchor.x - 1, 0, subjectZ + anchor.z).project(camera)
      const right = new Vector3(anchor.x + 1, 0, subjectZ + anchor.z).project(camera)
      return right.x - left.x
    }
    const ratio = projectedWidth(holdStart + 3) / projectedWidth(holdStart)
    const startGap = fitGap + 1.35 * 1.4
    expect(ratio).toBeCloseTo(startGap / (startGap + 1.35 * 3), 12)
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(0.84)
    console.info('projection metrics', { startGap, endGap: startGap + 1.35 * 3, ratio })
  })

  it('replays actual accumulated world-Z history over multiple beats and before frame zero', () => {
    const choreo = createChoreography(options)
    const history: SpacePoint[] = []
    for (let frame = 0; frame <= 60 * 48; frame++) {
      history.push({ x: choreo.state.headX, y: choreo.state.headY, z: choreo.state.headZ })
      if (frame < 60 * 48) choreo.update(1 / 60)
    }
    const out = { x: NaN, y: NaN, z: NaN }
    for (let frame = 0; frame < history.length; frame += 3) {
      choreo.sampleTrail(48 - frame / 60, out)
      for (const axis of axes) expect(out[axis]).toBeCloseTo(history[frame][axis], 9)
    }
    choreo.sampleTrail(48 + 5.5, out)
    expect(out).toEqual({ x: -2.56, y: 0, z: 1.35 * (-cycle + 6.5) })
    choreo.sampleTrail(48 + 5.5 + 2 * cycle, out)
    expect(out.z).toBe(1.35 * (-3 * cycle + 6.5))
    expect(history[history.length - 1].z - history[0].z).toBeCloseTo(4 * 1.35 * cycle, 10)
  })

  it('uses sanitized custom timings consistently in anchors, heads and choreography', () => {
    for (const custom of [
      { ...options, legSeconds: 1, gatherSeconds: 0.5, holdSeconds: 2, scatterSeconds: 0.5 },
      { ...options, legSeconds: NaN, gatherSeconds: 0, holdSeconds: Infinity, scatterSeconds: -1 },
    ]) {
      const expectedCycle = custom.legSeconds === 1 ? 4 : 12
      const legSeconds = custom.legSeconds === 1 ? 1 : 6.5
      const choreo = createChoreography(custom)
      choreo.update(3 * expectedCycle + legSeconds)
      expect(choreo.state.headZ).toBeCloseTo(1.35 * (3 * expectedCycle + legSeconds), 12)
      expect(glyphStopZ(3, custom)).toBe(1.35 * (3 * expectedCycle + legSeconds))
      expect(sampleHeadPosition(3, 'gather', 0, custom).z).toBe(glyphStopZ(3, custom))
    }
  })

  it('retains finite reusable outputs and a true X/Z tangent with invalid legacy sway', () => {
    const bad = { ...options, amplitudeX: NaN, swayY: Infinity, swayZ: NaN }
    const out = { x: NaN, y: NaN, z: NaN }
    for (const phase of ['travel', 'gather', 'hold', 'scatter'] as const) {
      for (const p of [NaN, Infinity, -Infinity, -1, 0, 0.62, 1, 2]) {
        for (const d of [0, 1, 2, 3] as const) {
          expect(sampleSpaceMotion(NaN, phase, p, bad, out, d)).toBe(out)
          for (const axis of axes) expect(Number.isFinite(out[axis])).toBe(true)
        }
      }
    }
    expect(sampleSpaceMotion(0, 'hold', 0.5, bad, out, 3)).toEqual({ x: 0, y: 0, z: 1 })
    for (const t of [NaN, Infinity, -Infinity, -1]) expect(cameraTravelAt(t)).toBe(0)
  })
})
