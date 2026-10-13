import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import HomeParticleBackground from '@/features/home-particle/HomeParticleBackground.vue'

const { engine, construct } = vi.hoisted(() => ({
  engine: {
    start: vi.fn(),
    stop: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    setReducedMotion: vi.fn(),
    dispose: vi.fn(),
    getStats: vi.fn(() => null),
  },
  construct: vi.fn(),
}))

vi.mock('@/features/home-particle/engine/ParticleEngine', () => ({
  ParticleEngine: construct,
}))

let wrapper: ReturnType<typeof mount> | undefined
let motion: MediaQueryList
let resize: ResizeObserverCallback
const observe = vi.fn()
const disconnect = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  construct.mockImplementation(() => engine)
  document.documentElement.classList.remove('dark')
  localStorage.clear()
  motion = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockReturnValue(motion)
  vi.stubGlobal('ResizeObserver', vi.fn((callback: ResizeObserverCallback) => {
    resize = callback
    return { observe, disconnect }
  }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
  localStorage.clear()
})

describe('HomeParticleBackground cosmos shell', () => {
  it.each(['light', 'dark'])('keeps the sky and dark engine palette for saved %s and later toggles', async (theme) => {
    localStorage.setItem('theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    wrapper = mount(HomeParticleBackground)

    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ isLightTheme: false }))
    expect(wrapper.get('.home-space-sky').isVisible()).toBe(true)
    expect(wrapper.classes()).toContain('pointer-events-none')
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(engine.start).toHaveBeenCalledOnce()

    document.documentElement.classList.toggle('dark')
    await nextTick()
    expect(engine.setTheme).not.toHaveBeenCalled()
    expect(construct).toHaveBeenCalledOnce()
    expect(wrapper.get('.home-space-sky').isVisible()).toBe(true)
  })

  it.each(['light', 'dark'])('retains the photograph when WebGL is unavailable with saved %s', async (theme) => {
    localStorage.setItem('theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    construct.mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
    wrapper = mount(HomeParticleBackground)
    await nextTick()

    expect(wrapper.get('.home-space-sky').isVisible()).toBe(true)
    const fallback = wrapper.get('.home-particle-fallback')
    expect(fallback.classes()).toContain('bg-transparent')
    expect(fallback.classes()).toContain('home-particle-fallback--on-sky')
    expect(fallback.classes()).not.toContain('bg-gray-50')
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('retains the photograph when a running engine reports a context failure', async () => {
    wrapper = mount(HomeParticleBackground)
    const options = construct.mock.calls[0][0] as { onError: () => void }
    options.onError()
    await nextTick()

    expect(wrapper.get('.home-space-sky').isVisible()).toBe(true)
    expect(wrapper.get('.home-particle-fallback').classes()).toContain('bg-transparent')
  })

  it('preserves active, visibility, motion, resize and disposal behavior', async () => {
    wrapper = mount(HomeParticleBackground, { props: { active: false } })
    expect(engine.start).not.toHaveBeenCalled()
    await wrapper.setProps({ active: true })
    expect(engine.start).toHaveBeenCalledOnce()

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.stop).toHaveBeenCalledOnce()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.start).toHaveBeenCalledTimes(2)
    await wrapper.setProps({ active: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.start).toHaveBeenCalledTimes(2)

    const onMotion = vi.mocked(motion.addEventListener).mock.calls[0][1] as (event: MediaQueryListEvent) => void
    onMotion({ matches: true } as MediaQueryListEvent)
    expect(engine.setReducedMotion).toHaveBeenCalledWith(true)
    expect(observe).toHaveBeenCalledWith(wrapper.element)
    resize([], {} as ResizeObserver)
    expect(engine.resize).toHaveBeenCalledOnce()

    wrapper.unmount()
    wrapper = undefined
    expect(engine.dispose).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(motion.removeEventListener).toHaveBeenCalledWith('change', onMotion)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.start).toHaveBeenCalledTimes(2)
  })

  it('passes the initial reduced-motion preference and cleans up window resize fallback', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...motion, matches: true })
    wrapper = mount(HomeParticleBackground)
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ reducedMotion: true }))
    window.dispatchEvent(new Event('resize'))
    expect(engine.resize).toHaveBeenCalledOnce()
    wrapper.unmount()
    wrapper = undefined
    window.dispatchEvent(new Event('resize'))
    expect(engine.resize).toHaveBeenCalledOnce()
  })
})
