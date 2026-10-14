/**
 * Lane L2 — quality ladder.
 *
 * The interesting part is pure: `probeQualityProfile(viewWidth, hints)` takes the
 * device hints as an argument, so the ladder can be graded without a DOM. The
 * defensiveness claims (jsdom has no `deviceMemory`, no WebGL, sometimes no
 * `matchMedia`) are checked by calling the real probe in this environment, which is
 * exactly the hostile one it has to survive.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createQualityProfile,
  detectSoftwareRenderer,
  probeQualityProfile,
  readDeviceHints,
  tierForHints,
  TIER_HIGH,
  TIER_LOW,
  TIER_MID,
  TIER_MINIMAL,
  QUALITY_TIERS,
} from '../quality'
import type { DeviceHints } from '../quality'
import {
  ADAPTIVE_PARTICLE_COUNT,
  BASE_PARTICLE_COUNT,
  BASE_STAR_COUNT,
  LOW_DPR,
  MAX_DPR,
  MIN_PARTICLE_COUNT,
  VENDOR_ICON_CANVAS_SIZE,
} from '../constants'

const PROFILE_KEYS = [
  'particleCount',
  'maxDpr',
  'antialias',
  'starCount',
  'tailSampleCount',
  'iconCanvasSize',
] as const

function hints(overrides: Partial<DeviceHints> = {}): DeviceHints {
  return {
    memoryGb: null,
    cores: null,
    dpr: 1,
    reducedMotion: false,
    softwareRenderer: false,
    ...overrides,
  }
}

/** A desktop that should clearly get the top rung. */
const HIGH_END = hints({ cores: 16, memoryGb: 16, dpr: 1 })

describe('quality: profile shape', () => {
  it('every rung carries all six fields as usable numbers', () => {
    expect(QUALITY_TIERS.length).toBeGreaterThanOrEqual(3)
    for (const [index, profile] of QUALITY_TIERS.entries()) {
      expect(Object.keys(profile).sort()).toEqual([...PROFILE_KEYS].sort())
      expect(Number.isFinite(profile.particleCount), `tier ${index}`).toBe(true)
      expect(profile.particleCount).toBeGreaterThan(0)
      expect(Number.isInteger(profile.particleCount)).toBe(true)
      expect(Number.isFinite(profile.maxDpr)).toBe(true)
      expect(profile.maxDpr).toBeGreaterThanOrEqual(LOW_DPR)
      expect(profile.maxDpr).toBeLessThanOrEqual(MAX_DPR)
      expect(typeof profile.antialias).toBe('boolean')
      expect(Number.isFinite(profile.starCount)).toBe(true)
      expect(profile.starCount).toBeGreaterThan(0)
      expect(Number.isInteger(profile.starCount)).toBe(true)
      expect(profile.tailSampleCount).toBeGreaterThan(0)
      expect(Number.isInteger(profile.tailSampleCount)).toBe(true)
      expect(profile.iconCanvasSize).toBeGreaterThan(0)
      expect(Number.isInteger(profile.iconCanvasSize)).toBe(true)
      expect(profile.iconCanvasSize).toBeLessThanOrEqual(VENDOR_ICON_CANVAS_SIZE)
    }
  })

  it('the top rung is the design budget and the bottom is the floor', () => {
    const high = QUALITY_TIERS[TIER_HIGH]
    expect(high.particleCount).toBe(BASE_PARTICLE_COUNT)
    expect(high.maxDpr).toBe(MAX_DPR)
    expect(high.starCount).toBe(BASE_STAR_COUNT)
    expect(high.iconCanvasSize).toBe(VENDOR_ICON_CANVAS_SIZE)
    expect(high.tailSampleCount).toBe(96)

    const minimal = QUALITY_TIERS[TIER_MINIMAL]
    expect(minimal.maxDpr).toBe(LOW_DPR)
    // §6 item 10 caps the reduced-motion path here.
    expect(minimal.particleCount).toBeLessThanOrEqual(MIN_PARTICLE_COUNT)
    expect(minimal.tailSampleCount).toBe(48)
  })

  it('every field is monotonically non-increasing down the ladder', () => {
    // The invariant that matters to the engine: a weaker device must never be asked
    // for more particles, more stars, a bigger trail sample or a higher DPR cap.
    // Antialiasing is a boolean and only ever goes true -> false.
    for (let tier = 1; tier < QUALITY_TIERS.length; tier++) {
      const stronger = QUALITY_TIERS[tier - 1]
      const weaker = QUALITY_TIERS[tier]
      expect(weaker.particleCount, `tier ${tier} particleCount`).toBeLessThanOrEqual(
        stronger.particleCount
      )
      expect(weaker.starCount, `tier ${tier} starCount`).toBeLessThanOrEqual(stronger.starCount)
      expect(weaker.maxDpr, `tier ${tier} maxDpr`).toBeLessThanOrEqual(stronger.maxDpr)
      expect(weaker.tailSampleCount, `tier ${tier} tailSampleCount`).toBeLessThanOrEqual(
        stronger.tailSampleCount
      )
      expect(weaker.iconCanvasSize, `tier ${tier} iconCanvasSize`).toBeLessThanOrEqual(
        stronger.iconCanvasSize
      )
      expect(stronger.antialias && !weaker.antialias || !stronger.antialias, `tier ${tier} aa`).toBe(
        true
      )
    }
  })

  it('the particle counts named by constants.ts are all reachable', () => {
    const counts = QUALITY_TIERS.map((profile) => profile.particleCount)
    expect(counts).toContain(BASE_PARTICLE_COUNT)
    expect(counts).toContain(ADAPTIVE_PARTICLE_COUNT)
    expect(counts).toContain(MIN_PARTICLE_COUNT)
  })
})

describe('quality: the ladder decision', () => {
  it('a strong desktop gets the top rung', () => {
    expect(tierForHints(hints({ cores: 16, memoryGb: 16 }))).toBe(TIER_HIGH)
    expect(tierForHints(hints({ cores: 8, memoryGb: 8 }))).toBe(TIER_HIGH)
  })

  it('a mid laptop gets the middle rung', () => {
    expect(tierForHints(hints({ cores: 4, memoryGb: 4 }))).toBe(TIER_MID)
    expect(tierForHints(hints({ cores: 8, memoryGb: 4 }))).toBe(TIER_MID)
  })

  it('a small device gets the low rung', () => {
    expect(tierForHints(hints({ cores: 2, memoryGb: 2 }))).toBe(TIER_LOW)
    expect(tierForHints(hints({ cores: 1, memoryGb: 1 }))).toBe(TIER_LOW)
    // The weaker signal decides: 8 threads next to 2 GiB is a Chromebook-class
    // machine, and RAM is the signal that tells the truth there.
    expect(tierForHints(hints({ cores: 8, memoryGb: 2 }))).toBe(TIER_LOW)
    expect(tierForHints(hints({ cores: 2, memoryGb: 16 }))).toBe(TIER_LOW)
  })

  it('a software rasteriser is pinned to the lowest rung whatever the CPU says', () => {
    expect(tierForHints(hints({ cores: 32, memoryGb: 64, softwareRenderer: true }))).toBe(
      TIER_MINIMAL
    )
  })

  it('prefers-reduced-motion is pinned to the lowest rung regardless of hardware', () => {
    // §6 item 10: this is the user's stated preference, not a capability question.
    expect(
      tierForHints(hints({ cores: 32, memoryGb: 64, reducedMotion: true }))
    ).toBe(TIER_MINIMAL)
    expect(
      tierForHints(hints({ cores: 32, memoryGb: 64, reducedMotion: true, softwareRenderer: false }))
    ).toBe(TIER_MINIMAL)
  })

  it('treats a missing hint as unknown, never as weak', () => {
    // Firefox and Safari never report `deviceMemory`. Reading `null` as "weak" would
    // hand a discrete-GPU desktop the 5000-particle rung.
    expect(tierForHints(hints({ cores: 16, memoryGb: null }))).toBe(TIER_HIGH)
    expect(tierForHints(hints({ cores: null, memoryGb: 16 }))).toBe(TIER_HIGH)
    // Both unknown: the middle rung, which is visually indistinguishable from the top.
    expect(tierForHints(hints({ cores: null, memoryGb: null }))).toBe(TIER_MID)
    // And an undecidable GL probe must not drag a strong machine down either.
    expect(tierForHints(hints({ cores: 16, memoryGb: 16, softwareRenderer: null }))).toBe(
      TIER_HIGH
    )
  })
})

describe('quality: probeQualityProfile', () => {
  it('returns a complete profile for every rung and screen size', () => {
    const widths = [320, 375, 640, 768, 1024, 1280, 1512, 1920, 2560, 3840, 5120]
    const devices = [
      HIGH_END,
      hints({ cores: 4, memoryGb: 4 }),
      hints({ cores: 2, memoryGb: 2 }),
      hints({ cores: 32, memoryGb: 64, softwareRenderer: true }),
      hints({ cores: null, memoryGb: null, dpr: 3 }),
      hints({ cores: 16, memoryGb: 16, dpr: 2, reducedMotion: true }),
    ]
    for (const device of devices) {
      for (const width of widths) {
        const profile = probeQualityProfile(width, device)
        expect(Object.keys(profile).sort(), `width=${width}`).toEqual([...PROFILE_KEYS].sort())
        for (const key of PROFILE_KEYS) {
          if (key === 'antialias') expect(typeof profile.antialias).toBe('boolean')
          else expect(Number.isFinite(profile[key]), `width=${width} ${key}`).toBe(true)
        }
        expect(profile.particleCount).toBeGreaterThan(0)
        expect(profile.maxDpr).toBeGreaterThan(0)
      }
    }
  })

  it('monotonically lowers the rung as the device gets weaker', () => {
    // Same viewport, progressively worse hardware: particleCount must never increase.
    const ladder = [
      hints({ cores: 16, memoryGb: 16 }),
      hints({ cores: 8, memoryGb: 4 }),
      hints({ cores: 4, memoryGb: 4 }),
      hints({ cores: 2, memoryGb: 2 }),
      hints({ cores: 1, memoryGb: 1 }),
      hints({ cores: 1, memoryGb: 1, softwareRenderer: true }),
    ]
    let previous = Infinity
    for (const [index, device] of ladder.entries()) {
      const profile = probeQualityProfile(1920, device)
      expect(profile.particleCount, `rung ${index}`).toBeLessThanOrEqual(previous)
      previous = profile.particleCount
    }
    expect(previous).toBeLessThan(BASE_PARTICLE_COUNT)
  })

  it('lowers the profile on a phone-width viewport', () => {
    const desktop = probeQualityProfile(1920, HIGH_END)
    const phone = probeQualityProfile(390, HIGH_END)
    expect(phone.particleCount).toBeLessThanOrEqual(desktop.particleCount)
    expect(tierForHints(HIGH_END)).toBe(TIER_HIGH)
    // The rung, not just the numbers: a 390 px viewport is at most the low rung.
    expect(phone.particleCount).toBeLessThanOrEqual(MIN_PARTICLE_COUNT)
    expect(phone.maxDpr).toBeLessThanOrEqual(LOW_DPR)
  })

  it('lowers the profile on a high-DPR 4K wall', () => {
    const wall = hints({ cores: 16, memoryGb: 16, dpr: 2 })
    const hd = probeQualityProfile(1920, wall)
    const uhd = probeQualityProfile(3840, wall)
    expect(uhd.particleCount).toBeLessThanOrEqual(hd.particleCount)
    expect(uhd.maxDpr).toBeLessThanOrEqual(hd.maxDpr)
    // Both stay under the fill-rate ceiling, which is the actual invariant: a wall of
    // fragments is what blows the frame budget, and the DPR cap is what fixes it.
    expect(1920 * Math.min(2, hd.maxDpr)).toBeLessThanOrEqual(4200)
    expect(3840 * Math.min(2, uhd.maxDpr)).toBeLessThanOrEqual(4200)
    // Never above the low rung: 4K at DPR 2 needs two steps down to get under it.
    expect(uhd.maxDpr).toBe(LOW_DPR)
  })

  it('returns an independent object each call', () => {
    // The Vue shell stores this in the engine options; a shared frozen rung would
    // make one engine's tuning everyone else's.
    const first = probeQualityProfile(1920, HIGH_END)
    const second = probeQualityProfile(1920, HIGH_END)
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
    expect(first).not.toBe(QUALITY_TIERS[TIER_HIGH])
    first.particleCount = 1
    expect(probeQualityProfile(1920, HIGH_END).particleCount).toBe(BASE_PARTICLE_COUNT)
    expect(QUALITY_TIERS[TIER_HIGH].particleCount).toBe(BASE_PARTICLE_COUNT)
  })

  it('survives a nonsense viewWidth', () => {
    for (const width of [0, -1, NaN, Infinity, -Infinity]) {
      const profile = probeQualityProfile(width, HIGH_END)
      expect(Number.isFinite(profile.particleCount), `width=${width}`).toBe(true)
      expect(profile.particleCount).toBeGreaterThan(0)
      expect(Number.isFinite(profile.maxDpr)).toBe(true)
      expect(profile.maxDpr).toBeGreaterThan(0)
    }
  })

  it('never returns a better rung than the hints justify', () => {
    // A viewport correction may only move *down* the ladder.
    const weak = hints({ cores: 2, memoryGb: 2 })
    const profile = probeQualityProfile(3840, weak)
    expect(profile.particleCount).toBeLessThanOrEqual(MIN_PARTICLE_COUNT)
  })
})

describe('quality: createQualityProfile', () => {
  it('fills unspecified knobs from the base profile', () => {
    const base = createQualityProfile({})
    expect(base).toEqual(QUALITY_TIERS[TIER_HIGH])
    expect(base.particleCount).toBe(BASE_PARTICLE_COUNT)
    expect(base.maxDpr).toBe(MAX_DPR)
    expect(base.tailSampleCount).toBe(96)
    expect(base.iconCanvasSize).toBe(VENDOR_ICON_CANVAS_SIZE)
  })

  it('applies the overrides it is given', () => {
    const profile = createQualityProfile({
      particleCount: 1234,
      maxDpr: 1.1,
      antialias: true,
      starCount: 42,
      tailSampleCount: 12,
      iconCanvasSize: 256,
    })
    expect(profile).toEqual({
      particleCount: 1234,
      maxDpr: 1.1,
      antialias: true,
      starCount: 42,
      tailSampleCount: 12,
      iconCanvasSize: 256,
    })
  })

  it('ignores undefined overrides instead of letting them clobber the default', () => {
    // `Partial<QualityProfile>` permits `{ particleCount: undefined }`, and a plain
    // spread would push that undefined into the geometry allocation as a NaN length.
    const profile = createQualityProfile({
      particleCount: undefined,
      starCount: undefined,
      maxDpr: undefined,
      antialias: undefined,
    })
    expect(profile.particleCount).toBe(BASE_PARTICLE_COUNT)
    expect(profile.starCount).toBe(BASE_STAR_COUNT)
    expect(profile.maxDpr).toBe(MAX_DPR)
    expect(profile.antialias).toBe(QUALITY_TIERS[TIER_HIGH].antialias)
  })

  it('clamps nonsense numbers rather than passing them downstream', () => {
    const profile = createQualityProfile({
      particleCount: NaN,
      starCount: -5,
      maxDpr: Number.POSITIVE_INFINITY,
      tailSampleCount: 0,
      iconCanvasSize: -1,
    })
    expect(profile.particleCount).toBe(BASE_PARTICLE_COUNT)
    expect(profile.starCount).toBeGreaterThan(0)
    expect(profile.maxDpr).toBe(MAX_DPR)
    expect(profile.tailSampleCount).toBeGreaterThan(0)
    expect(profile.iconCanvasSize).toBeGreaterThan(0)
    for (const key of PROFILE_KEYS) {
      if (key !== 'antialias') expect(Number.isFinite(profile[key]), key).toBe(true)
    }
  })

  it('keeps a fractional override usable and a boolean override honest', () => {
    const profile = createQualityProfile({ maxDpr: 1.75, antialias: false })
    expect(profile.maxDpr).toBe(1.75)
    expect(profile.antialias).toBe(false)
  })
})

describe('quality: hostile environments', () => {
  it('readDeviceHints survives this environment (no deviceMemory, no WebGL)', () => {
    // jsdom: `navigator.deviceMemory` is undefined, `navigator.hardwareConcurrency`
    // is present, `window.matchMedia` is stubbed by the setup file, and there is no
    // WebGL at all. That is the defensive case in one package.
    const result = readDeviceHints()
    expect(Object.keys(result).sort()).toEqual(
      ['cores', 'dpr', 'memoryGb', 'reducedMotion', 'softwareRenderer'].sort()
    )
    expect(result.memoryGb === null || Number.isFinite(result.memoryGb)).toBe(true)
    expect(result.cores === null || Number.isFinite(result.cores)).toBe(true)
    expect(result.dpr === null || Number.isFinite(result.dpr)).toBe(true)
    expect(typeof result.reducedMotion).toBe('boolean')
    expect(
      result.softwareRenderer === null || typeof result.softwareRenderer === 'boolean'
    ).toBe(true)
  })

  it('probeQualityProfile works with no hints supplied at all', () => {
    // The production call signature: `probeQualityProfile(window.innerWidth)`.
    const profile = probeQualityProfile(1440)
    expect(Number.isFinite(profile.particleCount)).toBe(true)
    expect(profile.particleCount).toBeGreaterThan(0)
    expect(profile.maxDpr).toBeGreaterThan(0)
    expect(typeof profile.antialias).toBe('boolean')
  })

  it('detectSoftwareRenderer returns null (not a throw) without WebGL', () => {
    // No WebGL in jsdom, so the honest answer is "cannot tell", and the ladder has to
    // treat that as unknown rather than as software.
    expect(detectSoftwareRenderer()).toBeNull()
  })

  it('detectSoftwareRenderer names a software rasteriser from the debug string', () => {
    // jsdom has no GL, so the globals and the canvas are stubbed. This is the only
    // way to exercise the renderer-string branch, and it is worth exercising: the
    // real-world case (a GPU process that quietly fell back to SwiftShader) is
    // exactly the one that a naive probe misses.
    const swiftShader =
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
    const hardware = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)'

    const installeStubs = (rendererName: string) => {
      const loseContext = vi.fn()
      const gl = {
        canvas: { width: 1, height: 1 },
        RENDERER: 0x1f01,
        getExtension: vi.fn((name: string) => {
          if (name === 'WEBGL_debug_renderer_info') {
            return { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 }
          }
          if (name === 'WEBGL_lose_context') return { loseContext, restoreContext: vi.fn() }
          return null
        }),
        getParameter: vi.fn((pname: number) => (pname === 0x9246 ? rendererName : 'masked')),
      }
      const originalRenderingContext = globalThis.WebGLRenderingContext
      const originalWebgl2 = globalThis.WebGL2RenderingContext
      globalThis.WebGLRenderingContext = function () {} as unknown as typeof WebGLRenderingContext
      globalThis.WebGL2RenderingContext = function () {} as unknown as typeof WebGL2RenderingContext
      const spy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation((() => gl) as unknown as HTMLCanvasElement['getContext'])
      return {
        loseContext,
        restore: () => {
          spy.mockRestore()
          globalThis.WebGLRenderingContext = originalRenderingContext
          globalThis.WebGL2RenderingContext = originalWebgl2
        },
      }
    }

    const software = installeStubs(swiftShader)
    try {
      expect(detectSoftwareRenderer()).toBe(true)
      expect(software.loseContext).toHaveBeenCalled()
    } finally {
      software.restore()
    }

    const gpu = installeStubs(hardware)
    try {
      expect(detectSoftwareRenderer()).toBe(false)
    } finally {
      gpu.restore()
    }

    const llvmpipe = installeStubs('Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)')
    try {
      expect(detectSoftwareRenderer()).toBe(true)
    } finally {
      llvmpipe.restore()
    }

    const basicDriver = installeStubs('Microsoft Basic Render Driver')
    try {
      expect(detectSoftwareRenderer()).toBe(true)
    } finally {
      basicDriver.restore()
    }

    expect(globalThis.WebGLRenderingContext).toBeUndefined()
  })

  it('survives a canvas whose getContext throws', () => {
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() => {
        throw new Error('driver exploded')
      }) as unknown as HTMLCanvasElement['getContext'])
    const original = globalThis.WebGLRenderingContext
    globalThis.WebGLRenderingContext = function () {} as unknown as typeof WebGLRenderingContext
    try {
      expect(() => detectSoftwareRenderer()).not.toThrow()
      expect(detectSoftwareRenderer()).toBeNull()
    } finally {
      spy.mockRestore()
      globalThis.WebGLRenderingContext = original
    }
  })

  it('treats a permissive-only context as software, a strict one as hardware', () => {
    const original = globalThis.WebGLRenderingContext
    globalThis.WebGLRenderingContext = function () {} as unknown as typeof WebGLRenderingContext

    // `failIfMajorPerformanceCaveat: true` refused, the permissive retry succeeded:
    // software is the only thing on offer here.
    let calls = 0
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((_type: string, attrs?: WebGLContextAttributes) => {
        calls += 1
        if (attrs?.failIfMajorPerformanceCaveat) return null
        return {
          canvas: { width: 1, height: 1 },
          getExtension: () => null,
          getParameter: () => 'unknown',
        }
      }) as unknown as HTMLCanvasElement['getContext'])
    try {
      expect(detectSoftwareRenderer()).toBe(true)
      expect(calls).toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
      globalThis.WebGLRenderingContext = original
    }
  })
})
