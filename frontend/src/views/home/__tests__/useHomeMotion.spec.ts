import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import { useCountUp, useReveal } from '../useHomeMotion'

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

  it('reveals an element only after it intersects', async () => {
    const { intersectAll } = installIntersectionObserver()

    const wrapper = mount(revealHost)
    expect(wrapper.text()).toBe('hidden')

    await intersectAll()

    expect(wrapper.text()).toBe('shown')
  })

  it('reveals immediately under prefers-reduced-motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)

    const wrapper = mount(revealHost)

    expect(wrapper.text()).toBe('shown')
  })

  it('reveals immediately when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    const wrapper = mount(revealHost)
    await nextTick()

    expect(wrapper.text()).toBe('shown')
  })
})
