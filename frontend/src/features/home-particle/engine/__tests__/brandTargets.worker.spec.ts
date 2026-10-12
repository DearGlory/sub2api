import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANDS } from '../constants'
import { createBrandTargetSource } from '../brandTargets'
import type { BrandTargetsRequest, BrandTargetsResponse } from '../brandTargetsRaster'
import type { BrandTargetSource, BrandTargets } from '../types'

class ControlledWorker {
  static instances: ControlledWorker[] = []
  onmessage: ((event: MessageEvent<BrandTargetsResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  requests: BrandTargetsRequest[] = []
  terminate = vi.fn()
  postMessage = vi.fn((request: BrandTargetsRequest) => this.requests.push(request))
  constructor() { ControlledWorker.instances.push(this) }
  reply(result: BrandTargets | null, index = 0) {
    const { id, slug } = this.requests[index]
    this.onmessage?.({ data: { id, slug, result } } as MessageEvent<BrandTargetsResponse>)
  }
}

function result(count = 300): BrandTargets {
  return { targets: new Float32Array(count * 3), strokeDepth: new Float32Array(count), anchorCount: 123 }
}

describe('brand prefetch worker ownership', () => {
  let source: BrandTargetSource
  let idle: Map<number, IdleRequestCallback>
  let nextIdle: number
  const flushIdle = () => {
    const callbacks = [...idle.values()]
    idle.clear()
    for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 })
  }
  const active = () => ControlledWorker.instances[0]

  beforeEach(() => {
    vi.useFakeTimers()
    idle = new Map()
    nextIdle = 0
    ControlledWorker.instances = []
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      idle.set(++nextIdle, callback)
      return nextIdle
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id))
    vi.stubGlobal('Path2D', class {})
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal('Worker', ControlledWorker)
    source = createBrandTargetSource()
  })

  afterEach(() => {
    source.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not rasterise or publish a glyph in any main-thread idle turn while the worker is pending', () => {
    const raster = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    source.prefetch('openai', 300, 760)
    flushIdle()
    expect(raster).not.toHaveBeenCalled()
    expect(active().requests).toHaveLength(1)
    expect(source.get('openai')).toBeNull()
  })

  it('deduplicates queued, in-flight and cached requests, and publishes the complete result atomically', () => {
    source.prefetch('openai', 300, 760)
    source.prefetch('openai', 600, 320)
    expect(idle.size).toBe(1)
    flushIdle()
    source.prefetch('openai', 600, 320)
    flushIdle()
    expect(active().requests).toHaveLength(1)
    expect(active().requests[0]).toMatchObject({ count: 300, canvasSize: 760 })
    const completed = result()
    active().reply(completed)
    expect(source.get('openai')).toBe(completed)
    expect(source.ensure('openai', 600)).toBe(completed)
    source.prefetch('openai', 300)
    expect(idle.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reuses one worker and matches out-of-order replies by slug and request id', () => {
    source.prefetch('openai', 300)
    source.prefetch('yi', 300)
    flushIdle()
    expect(ControlledWorker.instances).toHaveLength(1)
    const completed = result()
    active().reply(completed, 1)
    expect(source.get('yi')).toBe(completed)
    expect(source.get('openai')).toBeNull()
    active().onmessage?.({ data: { id: -1, slug: 'openai', result: completed } } as MessageEvent<BrandTargetsResponse>)
    expect(source.get('openai')).toBeNull()
    active().reply(completed)
    expect(source.get('openai')).toBe(completed)
  })

  it('keeps synchronous ensure authoritative when an in-flight result arrives late', () => {
    source.prefetch('openai', 300)
    flushIdle()
    vi.stubGlobal('Path2D', undefined)
    const immediate = source.ensure('openai', 128)
    expect(immediate?.targets.length).toBe(384)
    active().reply(result())
    expect(source.get('openai')).toBe(immediate)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels queued callbacks and ignores a callback already dispatched at disposal', () => {
    source.prefetch('openai', 300)
    const lateIdle = [...idle.values()][0]
    source.dispose()
    expect(idle.size).toBe(0)
    lateIdle({ didTimeout: true, timeRemaining: () => 0 })
    source.prefetch('yi', 300)
    expect(ControlledWorker.instances).toHaveLength(0)
    expect(source.get('openai')).toBeNull()
  })

  it('terminates once, clears timers and ignores late message/error callbacks after dispose', () => {
    source.prefetch('openai', 300)
    flushIdle()
    const worker = active()
    const lateMessage = worker.onmessage!
    const lateError = worker.onerror!
    source.dispose()
    source.dispose()
    lateMessage({ data: { ...worker.requests[0], result: result() } } as MessageEvent<BrandTargetsResponse>)
    lateError({ preventDefault() {} } as ErrorEvent)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
    expect(worker.onmessageerror).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(idle.size).toBe(0)
    expect(source.get('openai')).toBeNull()
    expect(source.ensure('openai', 300)).toBeNull()
  })

  it.each(['error', 'messageerror', 'null', 'partial', 'postMessage', 'timeout'])(
    'retries every pending glyph after %s without doing heavy work in the failure handler', (failure) => {
      source.prefetch('openai', 300)
      source.prefetch('yi', 300)
      flushIdle()
      const worker = active()
      const raster = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      if (failure === 'error') worker.onerror?.({ preventDefault() {} } as ErrorEvent)
      if (failure === 'messageerror') worker.onmessageerror?.()
      if (failure === 'null') worker.reply(null)
      if (failure === 'partial') worker.reply({ ...result(), strokeDepth: new Float32Array(1) })
      if (failure === 'timeout') vi.advanceTimersByTime(10000)
      if (failure === 'postMessage') {
        worker.postMessage.mockImplementation(() => { throw new Error('clone failed') })
        source.prefetch('claude', 300)
        flushIdle()
      }
      expect(raster).not.toHaveBeenCalled()
      expect(source.get('openai')).toBeNull()
      expect(worker.terminate).toHaveBeenCalledTimes(1)
      flushIdle()
      expect(source.get('openai')?.targets.length).toBe(900)
      expect(source.get('yi')?.targets.length).toBe(900)
      expect(ControlledWorker.instances).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['Worker', 'OffscreenCanvas', 'constructor'])('supports the idle fallback without %s', (missing) => {
    if (missing === 'constructor') vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP') } })
    else vi.stubGlobal(missing, undefined)
    vi.stubGlobal('Path2D', undefined)
    source.prefetch('openai', 300)
    expect(source.get('openai')).toBeNull()
    flushIdle()
    expect(source.get('openai')?.targets.length).toBe(900)
    expect(ControlledWorker.instances).toHaveLength(0)
  })

  it('supports timeout dispatch without requestIdleCallback and cancels that timeout on dispose', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    source.prefetch('openai', 300)
    vi.advanceTimersByTime(200)
    expect(active().requests).toHaveLength(1)
    source.prefetch('yi', 300)
    source.dispose()
    vi.advanceTimersByTime(10000)
    expect(active().requests).toHaveLength(1)
    expect(source.get('openai')).toBeNull()
  })

  it('runs the actual worker handler and transfers results equal to ensure for all 28 parsed assets', async () => {
    const width = 96
    const pixels = new Uint8ClampedArray(width * width * 4)
    // Asymmetric band exercises anchor ordering and uniform height levelling.
    for (let y = 12; y < 72; y++) {
      for (let x = 18; x < 81; x++) pixels[(y * width + x) * 4 + 3] = 255
    }
    const context = () => ({
      setTransform() {}, fill() {}, fillStyle: '', getImageData: () => ({ data: pixels }),
    })
    vi.stubGlobal('Path2D', class { addPath() {} ellipse() {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(context as never)
    const canvases: Array<{ width: number; height: number }> = []
    vi.stubGlobal('OffscreenCanvas', class {
      width = width
      height = width
      constructor() { canvases.push(this) }
      getContext = context
    })
    vi.stubGlobal('onmessage', null)
    const post = vi.fn()
    vi.stubGlobal('postMessage', post)
    await import('../brandTargets.worker')
    const handler = globalThis.onmessage as unknown as (event: MessageEvent<BrandTargetsRequest>) => void
    const sync = createBrandTargetSource()
    const seed = () => {
      let state = 123456789
      return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296)
    }
    try {
      for (const { slug } of BRANDS) {
        source.prefetch(slug, 300, width)
        flushIdle()
        const request = active().requests.at(-1)!
        vi.spyOn(Math, 'random').mockImplementation(seed())
        const expected = sync.ensure(slug, 300, width)
        vi.spyOn(Math, 'random').mockImplementation(seed())
        handler({ data: request } as MessageEvent<BrandTargetsRequest>)
        const [response, transfer] = post.mock.calls.at(-1) as [BrandTargetsResponse, Transferable[]]
        expect(response.result, slug).toEqual(expected)
        expect(response.result!.strokeDepth.some(value => value > 0)).toBe(true)
        expect(transfer).toEqual([response.result!.targets.buffer, response.result!.strokeDepth.buffer])
        active().reply(response.result, active().requests.length - 1)
        expect(source.get(slug)).toBe(response.result)
      }
      expect(canvases).toHaveLength(28)
      expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
      // Worker allocation failure answers null, allowing the DOM fallback.
      vi.stubGlobal('OffscreenCanvas', class { constructor() { throw new Error('allocation') } })
      handler({ data: active().requests[0] } as MessageEvent<BrandTargetsRequest>)
      expect(post.mock.calls.at(-1)).toEqual([
        { id: active().requests[0].id, slug: active().requests[0].slug, result: null }, [],
      ])
    } finally {
      sync.dispose()
    }
  })

  it('ignores invalid counts and unknown assets without starting work', () => {
    for (const count of [0, -1, NaN, Infinity]) source.prefetch('openai', count)
    source.prefetch('missing', 300)
    flushIdle()
    expect(ControlledWorker.instances).toHaveLength(0)
  })
})
