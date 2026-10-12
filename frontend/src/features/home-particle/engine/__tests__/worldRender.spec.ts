import { BufferAttribute, BufferGeometry, PerspectiveCamera, Points, PointsMaterial, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createEngineScratch, fillEmissionTable, paletteFor, ParticleEngine } from '../ParticleEngine'
import { cameraTravelAt, glyphStopZ } from '../spaceMotion'
import { CAMERA_FOV, GATHER_SECONDS, HOLD_SECONDS, LEG_SECONDS, SCATTER_SECONDS, SUBJECT_Z } from '../constants'
import type { BrandTargets, ChoreographyState, CometPhase } from '../types'

const timing = { legSeconds: LEG_SECONDS, gatherSeconds: GATHER_SECONDS, holdSeconds: HOLD_SECONDS, scatterSeconds: SCATTER_SECONDS }
const cycle = LEG_SECONDS + GATHER_SECONDS + HOLD_SECONDS + SCATTER_SECONDS
const count = 128

/** Real engine methods, motion API and three matrices, with manually controlled choreography state. */
function harness(leg = 0, light = false) {
  const scratch = createEngineScratch(count, 48)
  const state: ChoreographyState = {
    phase: 'hold', phaseProgress: 0, legIndex: leg, brandIndex: 0,
    fromX: leg % 2 ? 2.56 : -2.56, toX: leg % 2 ? -2.56 : 2.56,
    headX: leg % 2 ? -2.56 : 2.56, headY: 0, headZ: glyphStopZ(leg, timing),
  }
  const targets: BrandTargets = {
    targets: new Float32Array(count * 3), strokeDepth: new Float32Array(count).fill(0.2), anchorCount: count,
  }
  for (let i = 0; i < count; i++) {
    targets.targets.set([5.8 + Math.cos(i) * 3, Math.sin(i) * 4, (i % 3 - 1) * 0.15], i * 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(scratch.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(scratch.colors, 4))
  geometry.setAttribute('cometScale', new BufferAttribute(scratch.body.spriteScale, 1))
  const tailGeometry = new BufferGeometry()
  tailGeometry.setAttribute('position', new BufferAttribute(scratch.emittedTail.positions, 3))
  tailGeometry.setAttribute('color', new BufferAttribute(scratch.emittedTail.colors, 4))
  const points = new Points(geometry, new PointsMaterial())
  const tailPoints = new Points(tailGeometry, new PointsMaterial())
  points.position.z = tailPoints.position.z = SUBJECT_Z
  const camera = new PerspectiveCamera(CAMERA_FOV, 1.6, 0.1, 1000)
  const rect = { left: 0, top: 0, width: 1440, height: 900 }
  const choreography = {
    state,
    update: vi.fn(),
    nextBrand() { state.brandIndex = (state.brandIndex + 1) % engine.roster.length },
    setSwayY: vi.fn(),
    sampleTrail(_delay: number, out: { x: number; y: number; z: number }) {
      out.x = state.headX
      out.y = state.headY
      out.z = state.headZ
    },
  }
  const engine = Object.assign(Object.create(ParticleEngine.prototype) as {
    syncGlyph(): void
    advanceClock(delta: number): void
    advanceCamera(): void
    integrate(step: number, time: number, delta: number): void
    upload(): void
    resize(): void
    updateCameraFit(): void
    setReducedMotion(value: boolean): void
  }, {
    scratch, particleCount: count, choreography, geometry, tailGeometry, points, tailPoints, camera,
    palette: paletteFor(light), light, reducedMotion: false, disposed: false,
    renderedPhase: 'hold' as CometPhase, lastPhase: 'hold' as CometPhase, currentGlyphLeg: -1,
    renderedHead: new Vector3(state.headX, state.headY, state.headZ), holdFade: 0,
    pointer: { active: false, lastMove: 0, clientX: 0, clientY: 0 }, width: 1440, height: 900,
    container: { getBoundingClientRect: () => rect },
    renderer: { domElement: { getBoundingClientRect: () => rect }, setSize: vi.fn(), setPixelRatio: vi.fn() },
    starfield: { setReducedMotion: vi.fn() }, options: {}, roster: [{ slug: 'fixture' }], currentBrandSlug: 'fixture',
    brandSource: { prefetch: vi.fn(), ensure: vi.fn(() => targets) }, quality: { iconCanvasSize: 256, maxDpr: 1 },
    dollySeconds: leg * cycle + LEG_SECONDS + GATHER_SECONDS, fitDistance: 0, fitGap: 0,
  })
  engine.updateCameraFit()
  engine.syncGlyph()
  scratch.positions.set(scratch.glyphTargets)
  scratch.colors.fill(1)
  engine.advanceCamera()
  const render = (time = 8, delta = 1 / 60) => {
    engine.advanceCamera()
    engine.integrate(Math.min(delta * 60, 2), time, delta)
    engine.upload()
    points.updateMatrixWorld()
    tailPoints.updateMatrixWorld()
  }
  return { engine, state, scratch, points, tailPoints, camera, targets, choreography, rect, render }
}

const worldAnchor = (h: ReturnType<typeof harness>) => new Vector3(h.state.toX, 0, glyphStopZ(h.state.legIndex, timing)).applyMatrix4(h.points.matrixWorld)

describe('world-space rendering', () => {
  it.each([0, 1, 300])('holds the geometry anchor through gather, hold and early scatter on leg %s', leg => {
    const h = harness(leg)
    const anchorZ = glyphStopZ(leg, timing)
    for (const [phase, progress] of [['gather', 0], ['gather', 1], ['hold', 0], ['hold', 1], ['scatter', 0], ['scatter', 0.62]] as const) {
      h.state.phase = phase
      h.state.phaseProgress = progress
      h.render(8 + progress)
      expect(worldAnchor(h).toArray()).toEqual([h.state.toX, 0, SUBJECT_Z + anchorZ])
      expect(h.points.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0])
      expect(h.points.scale.toArray()).toEqual([1, 1, 1])
      expect(h.points.position.z).toBe(SUBJECT_Z)
      expect(h.tailPoints.matrixWorld.elements).toEqual(h.points.matrixWorld.elements)
      expect(h.scratch.positions.every(Number.isFinite)).toBe(true)
      expect(h.scratch.emittedTail.birthTime.every(t => t === -1)).toBe(true)
    }
    for (let i = 0; i < count; i++) {
      expect(h.scratch.positions[i * 3 + 2]).toBeCloseTo(anchorZ + h.scratch.body.offsets[i * 3 + 2], 3)
    }
  })

  it.each([0, 1, 300])('shrinks the same fixed glyph only through perspective on leg %s', leg => {
    const h = harness(leg)
    h.render()
    const before = h.scratch.glyphTargets.slice()
    const point = new Vector3(h.state.toX, 4, h.state.headZ + SUBJECT_Z)
    const firstY = point.clone().project(h.camera).y
    const firstGap = h.camera.position.z - worldAnchor(h).z
    const materialSize = h.points.material.size
    h.engine.dollySeconds += HOLD_SECONDS
    h.engine.advanceCamera()
    const lastY = point.clone().project(h.camera).y
    const lastGap = h.camera.position.z - worldAnchor(h).z
    expect(lastGap - firstGap).toBeCloseTo(cameraTravelAt(HOLD_SECONDS), 9)
    expect(lastY / firstY).toBeCloseTo(firstGap / lastGap, 9)
    expect(lastY / firstY).toBeGreaterThan(0.75)
    expect(lastY / firstY).toBeLessThan(0.9)
    expect(h.scratch.glyphTargets).toEqual(before)
    expect(h.points.material.size).toBe(materialSize)
    expect(h.points.scale.toArray()).toEqual([1, 1, 1])
  })

  it('keeps camera travel increasing across the old wrap and through world zero', () => {
    const h = harness()
    h.engine.fitDistance = -2
    let previous = -Infinity
    for (const seconds of [0, 1, 2, 149.9, 150, 151, 152.2, 153, 3600, 21600]) {
      h.engine.dollySeconds = seconds
      h.engine.advanceCamera()
      expect(h.camera.position.z).toBeGreaterThan(previous)
      expect(h.camera.position.z).toBeCloseTo(-2 + cameraTravelAt(seconds), 9)
      expect(h.camera.getWorldDirection(new Vector3()).toArray()).toEqual([-0, -0, -1])
      expect(h.points.position.z).toBe(SUBJECT_Z)
      expect(h.tailPoints.position.z).toBe(SUBJECT_Z)
      previous = h.camera.position.z
    }
  })

  it.each([0, 1, 300])('unprojects the pointer onto the current glyph plane on leg %s', leg => {
    const h = harness(leg)
    const local = new Vector3(h.state.toX + 0.25, 0.5, h.state.headZ)
    const ndc = local.clone().add(h.points.position).project(h.camera)
    h.engine.pointer.active = true
    h.engine.pointer.lastMove = performance.now()
    h.engine.pointer.clientX = (ndc.x + 1) * h.rect.width / 2
    h.engine.pointer.clientY = (1 - ndc.y) * h.rect.height / 2
    h.render()
    expect(h.scratch.pointerField.localX).toBeCloseTo(local.x, 6)
    expect(h.scratch.pointerField.localY).toBeCloseTo(local.y, 6)
    expect(h.scratch.pointerField.localZ).toBeCloseTo(local.z, 6)
  })

  it.each([false, true])('keeps colour and internal pose independent of accumulated Z (light=%s)', light => {
    const near = harness(0, light), far = harness(300, light)
    // Equal internal shape and wall time, translated by an integer number of legs.
    near.render(9)
    far.render(9)
    for (let i = 0; i < count * 4; i++) expect(far.scratch.colors[i]).toBeCloseTo(near.scratch.colors[i], 4)
    expect(far.points.quaternion.toArray()).toEqual(near.points.quaternion.toArray())
  })

  it('updates a single-brand roster each leg and nextBrand at the same phase', () => {
    const h = harness()
    h.state.legIndex = 1
    h.state.toX = -2.56
    h.engine.advanceClock(0)
    expect(h.scratch.glyphTargets[2]).toBeCloseTo(glyphStopZ(1, timing) + h.targets.targets[2], 5)
    expect(h.scratch.glyphTargets[0]).toBeCloseTo(h.targets.targets[0] - 5.8 - 2.56, 5)
    h.engine.roster.push({ slug: 'second' })
    h.choreography.nextBrand()
    const anchor = h.scratch.glyphTargets.slice()
    h.engine.advanceClock(0)
    expect(h.engine.brandSource.ensure).toHaveBeenLastCalledWith('second', count, 256)
    expect(h.state.legIndex).toBe(1)
    expect(h.state.phase).toBe('hold')
    expect(h.scratch.glyphTargets).toEqual(anchor)
  })

  it('parks missing anchors at the current world stop', () => {
    const h = harness(1)
    h.targets.targets = h.targets.targets.slice(0, 3)
    h.targets.strokeDepth = h.targets.strokeDepth.slice(0, 1)
    h.engine.syncGlyph()
    expect(h.scratch.glyphTargets.slice(-3)).toEqual(new Float32Array([h.state.toX, 0, glyphStopZ(1, timing)]))
  })

  it('rebases the last flight shape onto the exact arrival before gathering', () => {
    const h = harness(1)
    h.state.phase = 'travel'
    h.state.headX += 0.1
    h.state.headZ -= 0.1
    h.render()
    h.state.phase = 'gather'
    h.state.phaseProgress = 0
    h.state.headX = h.state.toX
    h.state.headZ = glyphStopZ(1, timing)
    h.render()
    for (let i = 0; i < count; i++) {
      expect(h.scratch.positions[i * 3]).toBeCloseTo(h.state.headX + h.scratch.body.offsets[i * 3], 5)
      expect(h.scratch.positions[i * 3 + 2]).toBeCloseTo(h.state.headZ + h.scratch.body.offsets[i * 3 + 2], 5)
    }
  })

  it('resizes the camera fit without translating the locked logo or either pool', () => {
    const h = harness(1)
    h.render()
    const anchor = worldAnchor(h).clone(), positions = h.scratch.positions.slice()
    h.rect.width = 390
    h.rect.height = 844
    h.engine.resize()
    h.engine.advanceCamera()
    expect(h.camera.aspect).toBe(390 / 844)
    expect(worldAnchor(h).toArray()).toEqual(anchor.toArray())
    expect(h.scratch.positions).toEqual(positions)
    expect(h.points.position.toArray()).toEqual(h.tailPoints.position.toArray())
  })

  it('freezes both clocks at the current epoch for reduced motion, then resumes together', () => {
    const h = harness(300)
    const seconds = h.engine.dollySeconds, cameraZ = h.camera.position.z
    h.engine.setReducedMotion(true)
    h.engine.advanceClock(1)
    h.render()
    expect(h.choreography.update).not.toHaveBeenCalled()
    expect(h.engine.dollySeconds).toBe(seconds)
    expect(h.camera.position.z).toBe(cameraZ)
    expect(h.scratch.emittedTail.birthTime.every(t => t === -1)).toBe(true)
    h.engine.setReducedMotion(false)
    h.engine.advanceClock(0.02)
    h.engine.advanceCamera()
    expect(h.choreography.update).toHaveBeenCalledWith(0.02)
    expect(h.camera.position.z - cameraZ).toBeCloseTo(cameraTravelAt(0.02), 8)
  })

  it('births in true X/Z and leaves born particles inertial while the camera retreats', () => {
    const h = harness(1)
    h.state.phase = 'travel'
    h.state.phaseProgress = 0.5
    const pool = h.scratch.emittedTail
    fillEmissionTable(h.scratch.tailTable, { sampleTrail(delay, out) {
      out.x = h.state.headX + delay
      out.y = 0
      out.z = h.state.headZ - delay * 3
    } }, h.scratch.probePoint)
    h.render(8, 0.1)
    expect(pool.active[0]).toBe(1)
    expect(Math.hypot(pool.birthPosition[0] - h.state.headX, pool.birthPosition[1], pool.birthPosition[2] - h.state.headZ)).toBeLessThan(0.2)
    expect(h.scratch.tailTable.vel[2]).toBeGreaterThan(0)
    expect(h.scratch.tailTable.axis[2]).toBeLessThan(0)
    const birth = pool.birthPosition.slice(0, 3), velocity = pool.birthVelocity.slice(0, 3)
    h.engine.dollySeconds += 0.1
    h.state.phase = 'gather'
    h.state.phaseProgress = 0
    h.render(8.1, 0.1)
    for (let j = 0; j < 3; j++) {
      expect(pool.birthPosition[j]).toBe(birth[j])
      expect(pool.positions[j]).toBeCloseTo(birth[j] + velocity[j] * pool.age[0], 5)
    }
    const world = new Vector3().fromArray(pool.positions).applyMatrix4(h.tailPoints.matrixWorld)
    expect(world.z).toBeCloseTo(SUBJECT_Z + birth[2] + velocity[2] * pool.age[0], 5)
    // Even an erroneously enabled caller cannot emit from a stationary nozzle.
    h.scratch.tailTable.vel.fill(0)
    const times = pool.birthTime.slice()
    pool.update(0.1, 5, true, h.scratch.tailTable, 0, 0, 100, h.engine.palette.core, h.engine.palette.accent, false)
    expect(pool.birthTime).toEqual(times)
  })
})
