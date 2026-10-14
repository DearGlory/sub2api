import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Group, type Camera, type Scene, type WebGLRenderer } from 'three'
import { ParticleEngine } from '../ParticleEngine'
import type { Choreography } from '../types'

vi.mock('../starfield', () => ({
  createStarfield: () => ({ object: new Group(), update: vi.fn(), setTheme: vi.fn(), setReducedMotion: vi.fn(), dispose: vi.fn() }),
}))
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas')
    info = { render: { calls: 0, triangles: 0 }, programs: [] as { object: object; getUniforms: ReturnType<typeof vi.fn> }[] }
    compile = vi.fn((scene: Scene, _camera: Camera) => {
      // Like installed three r184, compile visits hidden renderables too and
      // leaves first-use uniform/attribute reflection until getUniforms().
      scene.traverse(object => {
        if ('material' in object) this.info.programs.push({ object, getUniforms: vi.fn() })
      })
    })
    render = vi.fn()
    setPixelRatio = vi.fn()
    setSize = vi.fn()
    setClearColor = vi.fn()
    dispose = vi.fn()
    forceContextLoss = vi.fn()
  } }
})

type Access = {
  renderer: WebGLRenderer
  choreography: Choreography
  dollySeconds: number
  lastFrameMs: number
  running: boolean
}
const engines: ParticleEngine[] = []
let callbacks: Map<number, FrameRequestCallback>
let nextId: number
beforeEach(() => {
  callbacks = new Map()
  nextId = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback)
    return nextId
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)))
})
afterEach(() => {
  engines.splice(0).forEach(engine => engine.dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function harness(reducedMotion = false) {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => ({ width: 1440, height: 900 } as DOMRect)
  const onError = vi.fn()
  const engine = new ParticleEngine({
    container, brands: [{ slug: 'fixture', label: 'Fixture' }], reducedMotion,
    quality: { particleCount: 128, starCount: 0 }, onError,
    targetSource: { get: () => null, ensure: () => null, prefetch() {}, dispose() {} },
  })
  engines.push(engine)
  return { engine, access: engine as unknown as Access, onError, container }
}
function frame(now: number) {
  vi.spyOn(performance, 'now').mockReturnValue(now)
  const pending = [...callbacks.values()]
  callbacks.clear()
  pending.forEach(callback => callback(now))
}

describe('cold start program preparation', () => {
  it('prepares the real hidden coma/tail programs and first-use reflection before scheduling any animation', () => {
    const { engine, access } = harness()
    const { scene, camera } = engine.debugScene
    const programs = new Map<object, ReturnType<typeof vi.fn>>()
    const hidden = ['comet-coma-volume', 'comet-tail-volume'].map(name => scene.getObjectByName(name)!)
    expect(hidden.every(object => object && !object.visible)).toBe(true)
    expect(engine.tailPoints.geometry.getAttribute('color').array.every(value => value === 0)).toBe(true)
    scene.traverse(object => {
      if ('material' in object) programs.set(object, vi.fn())
    })
    const before = scene.toJSON()
    const compile = vi.mocked(access.renderer.compile)
    const implementation = compile.getMockImplementation()!
    compile.mockImplementation((...args) => {
      expect(callbacks.size).toBe(0)
      expect(access.dollySeconds).toBe(0)
      expect(access.lastFrameMs).toBe(0)
      expect(hidden.every(object => !object.visible)).toBe(true)
      const result = implementation(...args)
      expect(access.renderer.info.programs).toHaveLength(programs.size)
      return result
    })
    engine.start()
    expect(compile).toHaveBeenCalledTimes(1)
    expect(compile).toHaveBeenCalledWith(scene, camera)
    expect(access.renderer.info.programs).toHaveLength(programs.size)
    expect(programs.has(engine.tailPoints)).toBe(true)
    for (const object of hidden) expect(programs.has(object)).toBe(true)
    for (const program of access.renderer.info.programs!) expect(program.getUniforms).toHaveBeenCalledTimes(1)
    expect(scene.toJSON()).toEqual(before)
    expect(access.renderer.render).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(1)
    expect(access.dollySeconds).toBe(0)
    frame(50000)
    expect(access.dollySeconds).toBeCloseTo(1 / 60)
    expect(access.renderer.render).toHaveBeenCalledTimes(1)
  })

  it('prepares once across duplicate starts and stop/resume, excluding stopped time', () => {
    const { engine, access } = harness()
    engine.start()
    engine.start()
    expect(callbacks.size).toBe(1)
    frame(1000)
    engine.stop()
    expect(callbacks.size).toBe(0)
    const clock = access.dollySeconds
    engine.start()
    frame(50000)
    expect(access.dollySeconds - clock).toBeCloseTo(1 / 60)
    expect(access.renderer.compile).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('dispose prevents later starts and releases a prepared renderer once (started=%s)', started => {
    const { engine, access, container } = harness()
    if (started) engine.start()
    engine.dispose()
    engine.dispose()
    engine.start()
    expect(callbacks.size).toBe(0)
    expect(access.renderer.compile).toHaveBeenCalledTimes(started ? 1 : 0)
    expect(access.renderer.dispose).toHaveBeenCalledTimes(1)
    expect(access.renderer.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it.each(['compile', 'reflection'])('reports %s failure synchronously, stops, and permits a clean retry', stage => {
    const { engine, access, onError } = harness()
    const error = new Error('cold ' + stage + ' failure')
    const compile = vi.mocked(access.renderer.compile)
    const implementation = compile.getMockImplementation()!
    compile.mockImplementationOnce((...args) => {
      if (stage === 'compile') throw error
      const result = implementation(...args)
      vi.mocked(access.renderer.info.programs![0].getUniforms).mockImplementationOnce(() => { throw error })
      return result
    })
    expect(() => engine.start()).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
    expect(access.running).toBe(false)
    expect(callbacks.size).toBe(0)
    engine.start()
    expect(compile).toHaveBeenCalledTimes(2)
    expect(callbacks.size).toBe(1)
  })

  it('does not schedule a frame if context loss stops the engine during preparation', () => {
    const { engine, access, onError } = harness()
    vi.mocked(access.renderer.compile).mockImplementationOnce(() => {
      access.renderer.domElement.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
      return new Set()
    })
    engine.start()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(access.running).toBe(false)
    expect(callbacks.size).toBe(0)
  })

  it('prepares under reduced motion without advancing either clock, then resumes from that epoch', () => {
    const { engine, access } = harness(true)
    const before = { ...access.choreography.state }
    engine.start()
    frame(1000)
    frame(50000)
    expect(access.renderer.compile).toHaveBeenCalledTimes(1)
    expect(access.dollySeconds).toBe(0)
    expect(access.choreography.state).toEqual(before)
    engine.setReducedMotion(false)
    frame(50016)
    expect(access.dollySeconds).toBeCloseTo(0.016)
    expect(access.choreography.state.phaseProgress).toBeGreaterThan(0)
  })
})
