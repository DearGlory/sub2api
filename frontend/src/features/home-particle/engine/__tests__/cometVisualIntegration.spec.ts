import { afterEach, describe, expect, it, vi } from 'vitest'
import { Group } from 'three'
import { createCometVisual } from '../cometVisual'
import type { CometTailView, CometVisualFrame } from '../cometVisualContract'
import { ParticleEngine, createEngineScratch } from '../ParticleEngine'
import { SUBJECT_Z } from '../constants'
import type { Choreography } from '../types'

const rendererControl = vi.hoisted(() => ({ fail: false }))

// Exercise the real graph; spies only observe calls and inject explicit failures.
vi.mock('../cometVisual', async importOriginal => {
  const actual = await importOriginal<typeof import('../cometVisual')>()
  return { createCometVisual: vi.fn((options: import('../cometVisualContract').CometVisualOptions) => {
    const visual = actual.createCometVisual(options)
    vi.spyOn(visual, 'update')
    vi.spyOn(visual, 'dispose')
    return visual
  }) }
})
vi.mock('../starfield', () => ({
  createStarfield: () => ({ object: new Group(), update: vi.fn(), setTheme: vi.fn(), setReducedMotion: vi.fn(), dispose: vi.fn() }),
}))
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    constructor() { if (rendererControl.fail) throw new Error('explicit WebGL failure') }
    domElement = document.createElement('canvas')
    info = { render: { calls: 9, triangles: 1200 } }
    setPixelRatio = vi.fn()
    setSize = vi.fn()
    setClearColor = vi.fn()
    dispose = vi.fn()
    forceContextLoss = vi.fn()
  } }
})

type Access = {
  scratch: ReturnType<typeof createEngineScratch>
  choreography: Choreography
  cometVisualFrame: CometVisualFrame
  integrate(step: number, time: number, delta: number): void
  writeEmissionTable(): void
  upload(): void
  publishStats(now: number): void
}
const engines: ParticleEngine[] = []
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks() })

function harness(light = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const container = document.createElement('div')
  let width = 1440
  container.getBoundingClientRect = () => ({ width, height: 900 } as DOMRect)
  const engine = new ParticleEngine({
    container, brands: [{ slug: 'fixture', label: 'Fixture' }], isLightTheme: light,
    quality: { particleCount: 1024, starCount: 0 },
    targetSource: { get: () => null, ensure: () => null, prefetch() {}, dispose() {} },
  })
  engines.push(engine)
  const access = engine as unknown as Access
  const state = access.choreography.state
  const s = access.scratch
  for (let i = 0; i < s.body.alpha.length; i++) {
    s.glyphTargets[i * 3] = state.headX + Math.cos(i) * (2 + i % 53 / 15)
    s.glyphTargets[i * 3 + 1] = Math.sin(i) * (2 + i % 53 / 15)
    s.glyphTargets[i * 3 + 2] = state.headZ + (i % 3 - 1) * 0.1
  }
  let time = 1
  const render = (phase = state.phase, progress = state.phaseProgress) => {
    state.phase = phase
    state.phaseProgress = progress
    time += 1 / 60
    access.writeEmissionTable()
    access.integrate(1, time, 1 / 60)
    access.upload()
    access.publishStats(time * 1000)
  }
  return { engine, access, state, s, render, resize: () => { width = 390; engine.resize() } }
}

function radial(h: ReturnType<typeof harness>) {
  const radii: number[] = []
  let sum = 0, zMin = Infinity, zMax = -Infinity
  for (let i = 0; i < h.s.body.alpha.length; i++) {
    const k = i * 3
    const r = Math.hypot(h.s.positions[k] - h.state.headX, h.s.positions[k + 1] - h.state.headY, h.s.positions[k + 2] - h.state.headZ)
    radii.push(r)
    sum += r
    zMin = Math.min(zMin, h.s.positions[k + 2])
    zMax = Math.max(zMax, h.s.positions[k + 2])
  }
  radii.sort((a, b) => a - b)
  return { mean: sum / radii.length, median: radii[radii.length / 2], max: radii[radii.length - 1], depth: zMax - zMin }
}

describe('required comet model integration (real production graph)', () => {
  it('constructs the model, updates one frame with the real pool, counts bytes and releases it once', () => {
    const h = harness()
    expect(createCometVisual).toHaveBeenLastCalledWith({ particleCount: 1024, light: false, reducedMotion: false })
    expect(h.engine.cometVisual.object.parent).toBe(h.engine.debugScene.scene)
    expect(h.engine.cometVisual.object.position.toArray()).toEqual([0, 0, SUBJECT_Z])
    h.render('travel', 0.2)
    const frame = h.access.cometVisualFrame
    expect(h.engine.cometVisual.update).toHaveBeenLastCalledWith(frame, h.s.emittedTail)
    const material = h.engine.tailPoints.material
    expect(Array.isArray(material)).toBe(false)
    expect('opacity' in material && material.opacity).toBe(0)
    expect(h.engine.tailPoints.visible).toBe(true)
    expect(h.engine.tailPoints.geometry.getAttribute('position').itemSize).toBe(3)
    expect(h.engine.tailPoints.geometry.getAttribute('color').itemSize).toBe(4)
    const bytes = h.s.positions.byteLength + h.s.colors.byteLength + h.s.body.spriteScale.byteLength + h.s.emittedTail.positions.byteLength + h.s.emittedTail.colors.byteLength
    const events = h.engine.cometVisual.object.children.filter(o =>
      'material' in o && 'uniforms' in (o.material as object) &&
      'uEventMode' in (o.material as import('three').ShaderMaterial).uniforms)
    expect(events).toHaveLength(1)
    expect(h.engine.getStats().geometryBytes).toBe(bytes + h.engine.cometVisual.geometryBytes)
    const firstTime = frame.time
    h.render('scatter', 0.62)
    expect(h.access.cometVisualFrame).toBe(frame)
    expect(frame.time).toBeGreaterThan(firstTime)
    expect(frame.glyphMix).toBe(0)
    expect(frame.departure).toBe(0)
    expect([frame.headX, frame.headY, frame.headZ]).toEqual([h.state.headX, h.state.headY, h.state.headZ])
    expect(frame.phase).toBe('scatter')
    expect(frame.progress).toBe(0.62)
    expect(frame.delta).toBe(1 / 60)
    h.engine.dispose()
    h.engine.dispose()
    expect(h.engine.cometVisual.dispose).toHaveBeenCalledTimes(1)
    expect(h.engine.cometVisual.object.parent).toBeNull()
  })

  it('surfaces a missing factory and update failure without a production fallback', () => {
    vi.mocked(createCometVisual).mockImplementationOnce(() => { throw new Error('explicit factory failure') })
    expect(() => harness()).toThrow('explicit factory failure')
    const h = harness()
    vi.mocked(h.engine.cometVisual.update).mockImplementationOnce(() => { throw new Error('explicit update failure') })
    expect(() => h.render()).toThrow('explicit update failure')
  })

  it('releases the model if the WebGL constructor fails and rethrows the original error', () => {
    rendererControl.fail = true
    try {
      expect(() => harness()).toThrow('explicit WebGL failure')
      const result = vi.mocked(createCometVisual).mock.results.at(-1)
      expect(result?.type).toBe('return')
      expect(result?.value.dispose).toHaveBeenCalledTimes(1)
      expect(result?.value.object.parent).toBeNull()
    } finally {
      rendererControl.fail = false
    }
  })

  it.each([false, true])('freezes transitions and visual time; theme and resize preserve the epoch (light=%s)', light => {
    const h = harness(light)
    h.render('travel', 0.8)
    h.render('gather', 0.15)
    const frame = h.access.cometVisualFrame
    const before = { positions: h.s.positions.slice(), time: frame.time, progress: frame.progress, headZ: frame.headZ }
    h.engine.setReducedMotion(true)
    h.render()
    h.render()
    h.resize()
    h.engine.setTheme(!light)
    h.render()
    expect(h.s.positions).toEqual(before.positions)
    expect(frame.time).toBe(before.time)
    expect(frame.progress).toBe(before.progress)
    expect(frame.headZ).toBe(before.headZ)
    expect(frame.delta).toBe(0)
    expect(frame.reducedMotion).toBe(true)
    expect(frame.light).toBe(!light)
    expect(h.engine.cometVisual.object.position.z).toBe(SUBJECT_Z)
    const material = h.engine.tailPoints.material
    expect('opacity' in material && material.opacity).toBe(0)
    h.engine.setReducedMotion(false)
    h.render('gather', 0.25)
    expect(h.s.positions).not.toEqual(before.positions)
  })

  it('uploads accelerating ejection and collapse, with no target motion or retained shape allocation', () => {
    const h = harness()
    const source = h.s.shapeFrom, salt = h.s.tailSeed, out = h.s.transitionOut
    h.render('travel', 1)
    const gather = [0, 0.05, 0.15, 0.25].map(q => { h.render('gather', q); return radial(h) })
    expect(gather[3].median - gather[2].median).toBeGreaterThan((gather[2].median - gather[1].median) * 1.25)
    expect(gather[3].depth).toBeGreaterThan(3)
    h.render('gather', 1)
    h.render('hold', 1)
    const shape = h.s.positions.slice()
    const scatter = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(q => { h.render('scatter', q * 0.62); return radial(h) })
    expect(h.s.shapeFrom).toEqual(shape)
    expect(h.s.shapeFrom).toBe(source)
    expect(h.s.tailSeed).toBe(salt)
    expect(h.s.transitionOut).toBe(out)
    for (let j = 1; j < scatter.length; j++) {
      expect(scatter[j].mean).toBeLessThan(scatter[j - 1].mean)
      expect(scatter[j].median).toBeLessThan(scatter[j - 1].median)
      expect(scatter[j].max).toBeLessThan(scatter[j - 1].max)
    }
    const ratio = (scatter[3].mean - scatter[6].mean) / (scatter[0].mean - scatter[3].mean)
    expect(ratio).toBeGreaterThanOrEqual(1.8)
    console.info('actual uploaded transition geometry', { gather, scatter, secondHalfSpeedRatio: ratio })
  })

  it('keeps flight energy sparse and glyph coverage at one in both themes', () => {
    for (const light of [false, true]) {
      const h = harness(light)
      h.render('travel', 0.5)
      for (let i = 0; i < h.s.body.alpha.length; i++) {
        const energy = h.s.colors[i * 4 + 3] * h.s.body.spriteScale[i] ** 2
        expect(energy).toBeCloseTo(h.s.body.alpha[i] * (light ? 0.14 : 0.08), 6)
      }
      h.render('gather', 1)
      h.render('hold', 0)
      expect(h.s.body.spriteScale.every(value => value === 1)).toBe(true)
      for (let i = 0; i < h.s.body.alpha.length; i++) expect(h.s.colors[i * 4 + 3]).toBe(1)
    }
  })

  it('passes an already updated tail pool without copying its arrays', () => {
    const h = harness()
    let received: CometTailView | undefined
    vi.mocked(h.engine.cometVisual.update).mockImplementation((_frame, tail) => { received = tail })
    h.render('travel', 0.4)
    expect(received).toBe(h.s.emittedTail)
    expect(received?.positions).toBe(h.engine.tailPoints.geometry.getAttribute('position').array)
    expect(received?.colors).toBe(h.engine.tailPoints.geometry.getAttribute('color').array)
  })
})
