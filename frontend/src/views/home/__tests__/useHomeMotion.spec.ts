import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'

import { useCountUp, useReveal } from '../useHomeMotion'
import SectionReveal from '../SectionReveal.vue'

enableAutoUnmount(afterEach)

const revealHost = defineComponent({
  setup() {
    const { target, revealed } = useReveal<HTMLDivElement>()
    return { target, revealed }
  },
  render() {
    return h('div', { ref: 'target' }, this.revealed ? 'shown' : 'hidden')
  },
})

const countHost = defineComponent({
  props: { end: { type: Number, required: true } },
  setup(props) {
    const { target, display } = useCountUp(props.end)
    return { target, display }
  },
  render() {
    return h('span', { ref: 'target' }, this.display)
  },
})

/**
 * A stub observer that records its callbacks so a test can drive intersection by
 * hand — jsdom never intersects anything on its own.
 */
function installIntersectionObserver() {
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []

  class Observer {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      callbacks.push(callback)
    }
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
  }

  vi.stubGlobal('IntersectionObserver', Observer)

  return {
    intersectAll: async () => {
      callbacks.forEach((callback) => callback([{ isIntersecting: true }]))
      // The callback flips a ref; the DOM catches up on the next tick.
      await nextTick()
    },
  }
}

/** jsdom drives rAF off a timer, so a count needs real time to finish. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('useHomeMotion', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the final value immediately under prefers-reduced-motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)

    const wrapper = mount(countHost, { props: { end: 1234 } })

    expect(wrapper.text()).toBe('1,234')
  })

  it('shows the final value immediately when there is no IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    const wrapper = mount(countHost, { props: { end: 42 } })
    await nextTick()

    expect(wrapper.text()).toBe('42')
  })

  it('starts at zero and counts up to the final value once the element intersects', async () => {
    const { intersectAll } = installIntersectionObserver()

    const wrapper = mount(countHost, { props: { end: 500 } })
    expect(wrapper.text()).toBe('0')

    await intersectAll()
    await settle(1500)

    expect(wrapper.text()).toBe('500')
  })

  it('keeps the revealed boolean compatible under prefers-reduced-motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    expect(mount(revealHost).text()).toBe('shown')
  })
})

/** Layout is explicit: jsdom has no layout engine. Real browser validation is separate. */
describe('scroll-driven SectionReveal', () => {
  let layoutTop: number
  let height: number
  let frames: Map<number, FrameRequestCallback>
  let requestFrame: ReturnType<typeof vi.fn>
  let cancelFrame: ReturnType<typeof vi.fn>
  let media: MediaQueryList
  let mediaListeners: Set<EventListenerOrEventListenerObject>

  async function flushFrame() {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(performance.now()))
    await nextTick()
  }

  async function scrollTo(y: number) {
    vi.stubGlobal('scrollY', y)
    window.dispatchEvent(new Event('scroll'))
    await flushFrame()
  }

  async function reduceMotion(matches: boolean) {
    Object.defineProperty(media, 'matches', { configurable: true, value: matches })
    const event = Object.assign(new Event('change'), { matches })
    mediaListeners.forEach((listener) => {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    })
    await nextTick()
  }

  function reveal(delay = 0) {
    return mount(SectionReveal, {
      props: { delay },
      attrs: { class: 'h-full md:col-span-2', 'data-test': 'card' },
      slots: { default: '<button type="button">Action</button>' },
      attachTo: document.body,
    })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    installIntersectionObserver()
    layoutTop = 1200
    height = 300
    frames = new Map()
    let frameId = 0
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    cancelFrame = vi.fn((id: number) => frames.delete(id))
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    vi.stubGlobal('innerHeight', 1000)
    vi.stubGlobal('scrollY', 0)
    mediaListeners = new Set()
    media = {
      matches: false,
      addEventListener: vi.fn((_type, listener) => mediaListeners.add(listener)),
      removeEventListener: vi.fn((_type, listener) => mediaListeners.delete(listener)),
    } as unknown as MediaQueryList
    vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () {
      return (this as HTMLElement).hasAttribute('data-test') ? layoutTop : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      // Include the visual transform, as a browser does. It must not feed back
      // into the next progress measurement.
      const element = this as HTMLElement
      const translation = Number(element.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0)
      const scale = Number(element.style.transform.match(/scale\(([-\d.]+)\)/)?.[1] ?? 1)
      const top = layoutTop - window.scrollY + translation + height * (1 - scale) / 2
      return { top, bottom: top + height * scale, height: height * scale } as DOMRect
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('maps the entrance range to intermediate progress and reverses at the same positions', async () => {
    const wrapper = reveal()
    await nextTick()
    const element = wrapper.element as HTMLElement
    expect(element.style.opacity).toBe('0')
    expect(element.style.transform).toBe('translateY(24px) scale(0.99)')

    await scrollTo(390) // top 810: halfway from 92% to 70% of the viewport
    expect(Number(element.style.opacity)).toBeCloseTo(0.5)
    expect(element.style.transform).toBe('translateY(12px) scale(0.995)')
    expect(element.style.willChange).toBe('opacity, transform')
    const middle = element.style.cssText
    expect(frames.size).toBe(0) // no time-driven loop after scrolling stops
    await flushFrame()
    expect(element.style.cssText).toBe(middle)

    await scrollTo(500)
    expect(element.style.opacity).toBe('1')
    expect(element.style.willChange).toBe('')
    await scrollTo(1800) // fully above the viewport
    expect(element.style.opacity).toBe('1')
    await scrollTo(390)
    expect(element.style.cssText).toBe(middle)
    await scrollTo(410)
    expect(Number(element.style.opacity)).toBeGreaterThan(0.5)
    await scrollTo(390)
    expect(element.style.cssText).toBe(middle)
    await scrollTo(280)
    expect(element.style.opacity).toBe('0')
  })

  it('preserves single-root class/height/grid inheritance without layout writes', async () => {
    const wrapper = reveal()
    await scrollTo(390)
    expect(wrapper.classes()).toEqual(['h-full', 'md:col-span-2'])
    expect(wrapper.element.children).toHaveLength(1)
    expect(wrapper.element.firstElementChild?.tagName).toBe('BUTTON')
    const style = (wrapper.element as HTMLElement).style
    expect([style.height, style.margin, style.top, style.transition, style.filter]).toEqual(['', '', '', '', ''])
  })

  it('shows a tall mobile hero immediately and keeps its initial visible segment readable', async () => {
    vi.stubGlobal('innerHeight', 844)
    layoutTop = 40
    height = 1600
    const wrapper = reveal(200)
    await nextTick()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    await scrollTo(300)
    await scrollTo(0)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
  })

  it('keeps initially visible content readable but can retract when returned below its entrance', async () => {
    vi.stubGlobal('scrollY', 390)
    const wrapper = reveal()
    await nextTick()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    await scrollTo(0)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('0')
    await scrollTo(280) // initial-visible band: top 1030 -> 810, midpoint 920
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(0.5)
    await scrollTo(390)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
  })

  it('remeasures resize, layout shifts and a late pageshow scroll restore', async () => {
    const wrapper = reveal()
    await scrollTo(390)
    layoutTop = 1310
    window.dispatchEvent(new Event('resize'))
    await flushFrame()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('0')
    vi.stubGlobal('innerHeight', 1200)
    window.dispatchEvent(new Event('resize'))
    await flushFrame()
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo((1104 - 920) / 264)
    vi.stubGlobal('scrollY', 2000)
    window.dispatchEvent(new Event('pageshow'))
    await flushFrame()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
  })

  it('turns delay into bounded spatial stagger without any reveal timer', async () => {
    const timer = vi.spyOn(window, 'setTimeout')
    const wrapper = reveal(100)
    await scrollTo(390)
    // 100 legacy milliseconds -> 10px later; the mapping remains reversible.
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(100 / 220)
    await scrollTo(600)
    await scrollTo(390)
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(100 / 220)
    expect(timer).not.toHaveBeenCalled()
    wrapper.unmount()
    await scrollTo(0)
    const capped = reveal(100000)
    await scrollTo(390)
    expect(Number((capped.element as HTMLElement).style.opacity)).toBeCloseTo(86 / 220)
  })

  it('shows focused descendants synchronously without removing normal Tab navigation', async () => {
    const wrapper = reveal()
    await nextTick()
    const element = wrapper.element as HTMLElement
    const button = wrapper.get('button').element
    expect(element.style.opacity).toBe('0')
    expect(element.style.pointerEvents).toBe('none')
    expect(button.tabIndex).toBe(0)
    expect(element.hasAttribute('inert')).toBe(false)
    button.focus()
    // focusin must expose the target before a Vue microtask or browser paint.
    expect(element.style.opacity).toBe('1')
    expect(element.style.pointerEvents).toBe('')
    await scrollTo(0)
    expect(element.style.opacity).toBe('1')
    button.blur()
    await flushFrame()
    expect(element.style.opacity).toBe('0')
  })

  it('shares one passive scroll listener/frame and cleans up only after the last unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const first = reveal()
    const second = reveal()
    const scrollCalls = add.mock.calls.filter(([type]) => type === 'scroll')
    expect(scrollCalls).toHaveLength(1)
    expect(scrollCalls[0]?.[2]).toEqual({ passive: true })
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(1)
    expect(requestFrame).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(remove.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(0)
    second.unmount()
    expect(frames.size).toBe(0)
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    for (const type of ['scroll', 'resize', 'pageshow']) {
      const registered = add.mock.calls.find(([event]) => event === type)
      expect(registered).toBeDefined()
      expect(remove.mock.calls.some(([event, handler]) => event === type && handler === registered?.[1])).toBe(true)
    }
    expect(mediaListeners.size).toBe(0)
    window.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(0)
  })

  it('responds to reduced-motion changes immediately and cancels pending work', async () => {
    const wrapper = reveal()
    await scrollTo(390)
    window.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(1)
    await reduceMotion(true)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    expect((wrapper.element as HTMLElement).style.transform).toBe('none')
    expect(frames.size).toBe(0)
    await scrollTo(0)
    expect(frames.size).toBe(0)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    await reduceMotion(false)
    await flushFrame()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('0')
  })

  it.each(['matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'])(
    'fails open when %s is missing', async (capability) => {
      vi.stubGlobal(capability, undefined)
      const wrapper = reveal()
      await nextTick()
      expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
      expect(frames.size).toBe(0)
    },
  )

  it('keeps revealed a reversible boolean for existing composable consumers', async () => {
    const wrapper = mount(revealHost, { attrs: { 'data-test': 'card' } })
    await nextTick()
    expect(wrapper.text()).toBe('hidden')
    await scrollTo(500)
    expect(wrapper.text()).toBe('shown')
    await scrollTo(0)
    expect(wrapper.text()).toBe('hidden')
  })

  it('measures an offsetParent chain including borders without reading transformed bounds', async () => {
    const wrapper = reveal()
    const parent = document.createElement('section')
    Object.defineProperties(parent, {
      offsetTop: { value: 800 },
      clientTop: { value: 2 },
    })
    Object.defineProperties(wrapper.element, {
      offsetTop: { value: 398 },
      offsetParent: { value: parent },
    })
    await scrollTo(390)
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(0.5)
    await scrollTo(390)
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(0.5)
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled()
  })

  it('shows all content when mounted reduced and supports legacy media change listeners', async () => {
    Object.defineProperty(media, 'matches', { configurable: true, value: true })
    Object.assign(media, {
      addEventListener: undefined,
      removeEventListener: undefined,
      addListener: vi.fn((listener) => mediaListeners.add(listener)),
      removeListener: vi.fn((listener) => mediaListeners.delete(listener)),
    })
    const wrapper = reveal()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    expect(frames.size).toBe(0)
    await reduceMotion(false)
    await flushFrame()
    expect((wrapper.element as HTMLElement).style.opacity).toBe('0')
    wrapper.unmount()
    expect(mediaListeners.size).toBe(0)
  })

  it('fails open if media changes cannot be observed or the viewport has no layout', async () => {
    const addMediaListener = media.addEventListener
    Object.assign(media, { addEventListener: undefined })
    const unsupported = reveal()
    expect((unsupported.element as HTMLElement).style.opacity).toBe('1')
    unsupported.unmount()
    Object.assign(media, { addEventListener: addMediaListener })
    vi.stubGlobal('innerHeight', 0)
    const noLayout = reveal()
    expect((noLayout.element as HTMLElement).style.opacity).toBe('1')
  })

  it('does not depend on IntersectionObserver for reveal progress', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const wrapper = reveal()
    await scrollTo(390)
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeCloseTo(0.5)
  })
})
