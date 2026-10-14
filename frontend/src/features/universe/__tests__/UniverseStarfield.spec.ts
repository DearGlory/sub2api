import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { AdditiveBlending, Points, type Scene, type PerspectiveCamera } from 'three'
import { UniverseStarfield } from '../UniverseStarfield'
import UniverseBackground from '../UniverseBackground.vue'
import { CAMERA_FOV, DOLLY_FROM_Z } from '@/features/home-particle/engine/constants'
import type { QualityProfile } from '@/features/home-particle/engine/types'

const gpu = vi.hoisted(() => ({
  failCreate: false, failRender: false, failResize: false,
  renderers: [] as Array<{
    domElement: HTMLCanvasElement
    render: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    forceContextLoss: ReturnType<typeof vi.fn>
    setClearColor: ReturnType<typeof vi.fn>
    setPixelRatio: ReturnType<typeof vi.fn>
    setSize: ReturnType<typeof vi.fn>
  }>,
}))

// jsdom cannot create a GPU context. Keep the real Three scene, camera and starfield;
// replace only the renderer, without claiming its simulated calls are GPU evidence.
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: class {
      domElement = document.createElement('canvas')
      info = { render: { calls: 0 } }
      setClearColor = vi.fn()
      setPixelRatio = vi.fn()
      setSize = vi.fn(() => { if (gpu.failResize) throw new Error('resize failed') })
      dispose = vi.fn()
      forceContextLoss = vi.fn()
      render = vi.fn((scene: Scene, _camera: PerspectiveCamera) => {
        if (gpu.failRender) throw new Error('driver failed')
        this.info.render.calls = 0
        scene.traverse((object) => { if (object instanceof three.Points) this.info.render.calls++ })
      })
      constructor() {
        if (gpu.failCreate) throw new Error('WebGL unavailable')
        gpu.renderers.push(this)
      }
    },
  }
})

const quality: QualityProfile = {
  starCount: 900, maxDpr: 1, antialias: false,
  particleCount: 5000, tailSampleCount: 48, iconCanvasSize: 512,
}
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let hidden: boolean
let media: MediaQueryList
let observerCallback: ResizeObserverCallback | undefined
let disconnect: ReturnType<typeof vi.fn>
let engine: UniverseStarfield | undefined
let wrapper: ReturnType<typeof mount> | undefined

function frame(time: number) {
  const pending = Array.from(frames.values())
  frames.clear()
  pending.forEach(callback => callback(time))
}

function createEngine(reducedMotion = false, onError = vi.fn()) {
  const container = document.createElement('div')
  const photo = document.createElement('div')
  photo.className = 'photo'
  container.appendChild(photo)
  engine = new UniverseStarfield({ container, quality, reducedMotion, onError })
  return { engine, container, onError }
}

beforeEach(() => {
  gpu.failCreate = false
  gpu.failRender = false
  gpu.failResize = false
  gpu.renderers.length = 0
  frames = new Map()
  nextFrame = 0
  hidden = false
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  media = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observerCallback = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  engine?.dispose()
  engine = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('UniverseStarfield lifecycle with the real starfield', () => {
  it('contains only the four home starfield layers in a dark transparent scene', () => {
    const { engine, container } = createEngine()
    engine.start()
    frame(100)
    const renderer = gpu.renderers[0]
    const [scene, camera] = renderer.render.mock.calls[0] as [Scene, PerspectiveCamera]
    expect(scene.children).toHaveLength(1)
    expect(scene.children[0].name).toBe('starfield')
    expect(scene.children[0].children).toHaveLength(4)
    for (const layer of scene.children[0].children) {
      expect(layer).toBeInstanceOf(Points)
      expect((layer as Points).material).toMatchObject({ blending: AdditiveBlending })
    }
    expect(camera.fov).toBe(CAMERA_FOV)
    expect(camera.position.z).toBe(DOLLY_FROM_Z)
    expect(renderer.setClearColor).toHaveBeenCalledWith('#03040a', 0)
    expect(renderer.setPixelRatio).toHaveBeenCalledWith(1)
    expect(container.lastElementChild).toBe(renderer.domElement)
    expect(renderer.domElement.style.position).toBe('absolute')
    expect(renderer.domElement.style.inset).toBe('0')
    expect(engine.getStats()).toMatchObject({
      drawCalls: 4, starfieldLayers: 4, starCount: 900,
      cometCount: 0, tailCount: 0, brandCount: 0,
    })
  })

  it('cancels RAF and resumes without a hidden-tab time jump', () => {
    const { engine } = createEngine()
    engine.start()
    engine.start()
    expect(frames.size).toBe(1)
    frame(100)
    frame(120)
    const camera = gpu.renderers[0].render.mock.calls[0][1] as PerspectiveCamera
    const previousZ = camera.position.z
    expect(previousZ).toBeGreaterThan(DOLLY_FROM_Z)
    engine.stop()
    expect(frames.size).toBe(0)
    engine.start()
    frame(100000)
    expect(camera.position.z).toBe(previousZ)
  })

  it('renders one reduced-motion frame, updates on resize, and restarts when allowed', () => {
    const { engine } = createEngine(true)
    engine.start()
    expect(gpu.renderers[0].render).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    engine.resize()
    expect(gpu.renderers[0].render).toHaveBeenCalledTimes(2)
    engine.setReducedMotion(false)
    expect(frames.size).toBe(1)
    frame(100)
    engine.setReducedMotion(true)
    expect(frames.size).toBe(0)
    expect(engine.getStats().reducedMotion).toBe(true)
    engine.stop()
    engine.resize()
    expect(gpu.renderers[0].render).toHaveBeenCalledTimes(4)
  })

  it('releases every geometry, material and renderer once on context loss', () => {
    const { engine, container, onError } = createEngine()
    engine.start()
    frame(100)
    const renderer = gpu.renderers[0]
    const scene = renderer.render.mock.calls[0][0] as Scene
    const resources = scene.children[0].children.flatMap((child) => {
      const points = child as Points
      const material = Array.isArray(points.material) ? points.material : [points.material]
      return [vi.spyOn(points.geometry, 'dispose'), ...material.map(value => vi.spyOn(value, 'dispose'))]
    })
    const event = new Event('webglcontextlost', { cancelable: true })
    renderer.domElement.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    expect(container.querySelector('canvas')).toBeNull()
    engine.dispose()
    engine.start()
    engine.resize()
    expect(frames.size).toBe(0)
    resources.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1))
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1)
  })

  it('cleans up a partially constructed renderer if sizing throws', () => {
    gpu.failResize = true
    const container = document.createElement('div')
    expect(() => new UniverseStarfield({ container, quality, reducedMotion: false, onError: vi.fn() })).toThrow('resize failed')
    expect(container.querySelector('canvas')).toBeNull()
    expect(gpu.renderers[0].dispose).toHaveBeenCalledTimes(1)
  })
})

describe('UniverseBackground browser lifecycle', () => {
  it('pauses when hidden, reacts to motion and resize, and releases listeners on unmount', async () => {
    const removeMotion = vi.spyOn(media, 'removeEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    wrapper = mount(UniverseBackground)
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(frames.size).toBe(1)
    frame(100)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1)
    media.dispatchEvent(Object.assign(new Event('change'), { matches: true }))
    expect(frames.size).toBe(0)
    const render = gpu.renderers[0].render
    const rendered = render.mock.calls.length
    observerCallback?.([], {} as ResizeObserver)
    window.dispatchEvent(new Event('resize'))
    expect(render).toHaveBeenCalledTimes(rendered + 2)
    wrapper.unmount()
    wrapper = undefined
    await nextTick()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(removeMotion).toHaveBeenCalledWith('change', expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    expect(gpu.renderers[0].dispose).toHaveBeenCalledOnce()
  })

  it('does not start a hidden tab and uses the existing phone quality profile', () => {
    hidden = true
    vi.stubGlobal('innerWidth', 390)
    wrapper = mount(UniverseBackground)
    expect(frames.size).toBe(0)
    expect(gpu.renderers[0].render).not.toHaveBeenCalled()
    const stats = (wrapper.vm as unknown as { getStats: () => { starCount: number } }).getStats()
    expect(stats.starCount).toBeLessThanOrEqual(900)
  })

  it.each(['create', 'context', 'render', 'resize'])('keeps the real photo as fallback on %s failure', async (failure) => {
    gpu.failCreate = failure === 'create'
    wrapper = mount(UniverseBackground)
    if (failure === 'context') gpu.renderers[0].domElement.dispatchEvent(new Event('webglcontextlost'))
    if (failure === 'render') {
      gpu.failRender = true
      frame(100)
    }
    if (failure === 'resize') {
      gpu.failResize = true
      window.dispatchEvent(new Event('resize'))
    }
    await nextTick()
    expect(wrapper.attributes('data-fallback')).toBe('true')
    expect(wrapper.find('.universe-space-sky').exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(false)
    expect(frames.size).toBe(0)
    if (failure !== 'create') expect(disconnect).toHaveBeenCalledOnce()
  })
})
