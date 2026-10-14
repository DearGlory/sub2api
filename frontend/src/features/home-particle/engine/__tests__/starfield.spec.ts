/**
 * Lane L3 — deep-space starfield (HOME-PARTICLE-DESIGN.md §7, R1).
 *
 * jsdom has no real WebGL, but `Points`, `BufferGeometry` and `PointsMaterial` are
 * plain objects, so the tree, the recycle maths and the theme switches are all
 * assertable without a GL context. Nothing here needs a renderer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AdditiveBlending, NormalBlending, Points } from 'three'
import { createStarfield, STARFIELD_SPACE_COLOR_DARK, STARFIELD_SPACE_COLOR_LIGHT } from '../starfield'
import type { Starfield } from '../types'

/** The four children the header promises: three star layers plus the wash. */
const LAYER_COUNT = 4
/** The wash is the last child; the three recycled star layers come first. */
const STAR_LAYER_COUNT = 3

function pointsOf(starfield: Starfield): Points[] {
  return starfield.object.children.filter(
    (child): child is Points => (child as Points).isPoints === true
  )
}

function positionsOf(points: Points): Float32Array {
  return points.geometry.getAttribute('position').array as Float32Array
}

function colorsOf(points: Points): Float32Array {
  return points.geometry.getAttribute('color').array as Float32Array
}

/** Every `z` in a layer, i.e. the stars' depth in the group's own space. */
function depthsOf(points: Points): number[] {
  const positions = positionsOf(points)
  const depths: number[] = []
  for (let i = 2; i < positions.length; i += 3) depths.push(positions[i])
  return depths
}

/**
 * Feeds a camera path and returns the monotonic travel the module should have
 * accumulated: only increases count, and the very first sample establishes the
 * baseline rather than contributing a step.
 */
function driveCamera(
  starfield: Starfield,
  samples: { delta: number; cameraZ: number; time: number }[]
): number {
  let travelled = 0
  let previous: number | null = null
  for (const sample of samples) {
    starfield.update(sample.delta, sample.cameraZ, sample.time)
    if (previous !== null && sample.cameraZ > previous) {
      travelled += sample.cameraZ - previous
    }
    previous = sample.cameraZ
  }
  return travelled
}

describe('createStarfield', () => {
  let starfield: Starfield | null = null

  afterEach(() => {
    starfield?.dispose()
    starfield = null
  })

  it('always builds the same fixed tree, whatever the count', () => {
    for (const count of [0, 1, 2, 7, 600, 2600, 26000]) {
      const created = createStarfield({ count })
      try {
        expect(created.object.children.length, `count=${count}`).toBe(LAYER_COUNT)
        expect(pointsOf(created).length, `count=${count}`).toBe(LAYER_COUNT)
      } finally {
        created.dispose()
      }
    }
  })

  it('places roughly the requested number of stars', () => {
    for (const count of [600, 2600, 9000]) {
      const created = createStarfield({ count })
      try {
        const stars = pointsOf(created)
          .slice(0, STAR_LAYER_COUNT)
          .reduce((total, points) => total + positionsOf(points).length / 3, 0)
        expect(stars, `count=${count}`).toBeGreaterThanOrEqual(count * 0.9)
        expect(stars, `count=${count}`).toBeLessThanOrEqual(count * 1.1)
      } finally {
        created.dispose()
      }
    }
  })

  it('keeps the star layers in disjoint, ordered depth bands', () => {
    starfield = createStarfield({ count: 3000 })
    const layers = pointsOf(starfield).slice(0, STAR_LAYER_COUNT)

    let previousNearest = Infinity
    let previousFurthest = Infinity

    for (const [index, points] of layers.entries()) {
      const depths = depthsOf(points)
      const furthest = Math.min(...depths)
      const nearest = Math.max(...depths)

      // Every layer sits strictly behind the origin, on the camera's far side.
      expect(nearest, `layer ${index} crosses the camera plane`).toBeLessThan(0)
      // The band starts beyond the previous layer's far edge. A gap is allowed and
      // expected (the bands are authored with slack); an overlap is not, because a
      // "far" star drifting close to the lens would flatten the parallax.
      expect(nearest, `layer ${index} overlaps the one in front`).toBeLessThanOrEqual(
        previousFurthest
      )
      expect(nearest).toBeLessThanOrEqual(previousNearest)

      previousNearest = nearest
      previousFurthest = furthest
    }

    // The three bands together span a real amount of depth, which is what the
    // parallax is made of.
    const all = layers.flatMap((points) => depthsOf(points))
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(400)
  })

  it('recycles stars across many updates without leaking or drifting', () => {
    starfield = createStarfield({ count: 1200 })
    const object = starfield.object
    const childrenAfterBuild = object.children.length
    const layers = pointsOf(starfield).slice(0, STAR_LAYER_COUNT)

    // Run well past several band lengths, so stars are driven through the recycle
    // repeatedly, and include one huge step of the kind a backgrounded tab
    // produces, which the closed-form jump has to absorb without spinning.
    let cameraZ = 15
    const samples = [{ delta: 1 / 60, cameraZ, time: 0 }]
    for (let frame = 1; frame <= 600; frame++) {
      cameraZ += 0.55
      samples.push({ delta: 1 / 60, cameraZ, time: frame / 60 })
    }
    cameraZ += 250
    samples.push({ delta: 4.2, cameraZ, time: 11 })
    for (let frame = 0; frame < 60; frame++) {
      cameraZ += 0.55
      samples.push({ delta: 1 / 60, cameraZ, time: 12 + frame / 60 })
    }

    const travelled = driveCamera(starfield, samples)

    expect(travelled).toBeGreaterThan(600)
    expect(object.children.length).toBe(childrenAfterBuild)
    expect(object.children.length).toBe(LAYER_COUNT)

    for (const [index, points] of layers.entries()) {
      const positions = positionsOf(points)
      expect(positions.length % 3).toBe(0)
      for (let i = 0; i < positions.length; i++) {
        expect(Number.isFinite(positions[i])).toBe(true)
      }

      // The recycle's own postcondition: every star was mapped back inside
      // `(travelled - farDepth, travelled - nearDepth]`. A star outside that window
      // would either never fade or never come back.
      const depths = depthsOf(points)
      if (depths.length === 0) continue
      // Bands are 180 / 260 / 380 deep, in layer order.
      const band = [180, 260, 380][index]
      const nearDepth = [60, 240, 500][index]
      const windowFar = travelled - nearDepth - band
      const windowNear = travelled - nearDepth
      expect(Math.min(...depths), `layer ${index} star behind the far edge`).toBeGreaterThan(
        windowFar - 1e-3
      )
      expect(Math.max(...depths), `layer ${index} star in front of the near edge`).toBeLessThanOrEqual(
        windowNear + 1e-3
      )
    }
  })

  it('survives degenerate update arguments without producing NaN', () => {
    starfield = createStarfield({ count: 300 })
    starfield.update(Number.NaN, Number.NaN, Number.NaN)
    starfield.update(0, 0, 0)
    starfield.update(-1, -50, 1)
    starfield.update(1e9, 1e9, 1e9)

    for (const points of pointsOf(starfield)) {
      const positions = positionsOf(points)
      for (let i = 0; i < positions.length; i++) {
        expect(Number.isFinite(positions[i])).toBe(true)
      }
      const colors = colorsOf(points)
      for (let i = 0; i < colors.length; i++) {
        expect(Number.isFinite(colors[i])).toBe(true)
      }
      expect(Number.isFinite(points.position.z)).toBe(true)
    }
  })

  it('moves with the camera so the field never runs out', () => {
    starfield = createStarfield({ count: 300 })
    starfield.update(1 / 60, 15, 0)
    const atStart = starfield.object.position.z
    starfield.update(1 / 60, 15.55, 1 / 60)
    const afterOneStep = starfield.object.position.z

    // The group tracks the camera... except for the travel it has absorbed, which
    // is what keeps the dolly's periodic wrap out of the stars' geometry.
    expect(atStart).toBeCloseTo(15, 6)
    expect(afterOneStep).toBeCloseTo(15, 6)
  })

  it('switches blending and shading with the theme', () => {
    starfield = createStarfield({ count: 600, isLightTheme: false })
    const layers = pointsOf(starfield)

    expect(layers.every((points) => points.material.blending === AdditiveBlending)).toBe(true)

    // Bake a dark frame so the colour buffers hold dark-theme values.
    starfield.update(1 / 60, 15.55, 0.02)
    const darkColors = Float32Array.from(colorsOf(layers[0]))

    starfield.setTheme(true)

    // The blending mode is the whole point of the theme split: additive stars glow
    // on a pale page and read as a fake light source.
    expect(layers.every((points) => points.material.blending === NormalBlending)).toBe(true)

    const lightColors = colorsOf(layers[0])
    let differences = 0
    for (let i = 0; i < lightColors.length; i++) {
      if (lightColors[i] !== darkColors[i]) differences++
    }
    expect(differences).toBeGreaterThan(0)

    // Idempotent: setting the same theme twice must not reshuffle the sky again.
    const snapshot = Array.from(lightColors)
    starfield.setTheme(true)
    expect(Array.from(colorsOf(layers[0]))).toEqual(snapshot)

    starfield.setTheme(false)
    expect(layers.every((points) => points.material.blending === AdditiveBlending)).toBe(true)
  })

  it('publishes a space colour for each theme', () => {
    expect(STARFIELD_SPACE_COLOR_DARK).toMatch(/^#[0-9a-f]{6}$/i)
    expect(STARFIELD_SPACE_COLOR_LIGHT).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('stops animating under reduced motion while keeping depth shading', () => {
    starfield = createStarfield({ count: 600 })
    starfield.update(0.5, 15.28, 1)
    const spinning = pointsOf(starfield)[0].rotation.z

    starfield.setReducedMotion(true)
    starfield.update(0.5, 15.55, 2)

    // Rotation is frozen, but the buffers are still shaded: the depth fade must not
    // be dropped, or the field would pop every time a star recycled.
    expect(pointsOf(starfield)[0].rotation.z).toBe(spinning)
    expect(colorsOf(pointsOf(starfield)[0]).some((value) => value > 0)).toBe(true)

    starfield.setReducedMotion(false)
    starfield.update(0.5, 15.83, 3)
    expect(pointsOf(starfield)[0].rotation.z).not.toBe(spinning)
  })

  it('empties the tree on dispose and releases every GPU resource', () => {
    starfield = createStarfield({ count: 800 })
    expect(starfield.object.children.length).toBe(LAYER_COUNT)

    const layers = pointsOf(starfield)
    const released = { geometry: 0, material: 0 }
    // `dispose()` on a geometry or material does not clear its own attributes —
    // it fires this event and hands the release to the renderer — so the event is
    // the only honest evidence that the buffers were freed.
    for (const points of layers) {
      points.geometry.addEventListener('dispose', () => released.geometry++)
      points.material.addEventListener('dispose', () => released.material++)
    }

    starfield.dispose()

    expect(starfield.object.children.length).toBe(0)
    expect(released.geometry).toBe(LAYER_COUNT)
    expect(released.material).toBe(LAYER_COUNT)

    // The glow texture cannot be asserted here: jsdom has no 2D context, so
    // `createGlowTexture` returned `null` and no layer ever received a map. In a
    // real browser `dispose()` releases it (it is created once and held only by
    // these four materials), which the browser-side probe covers.

    // Every entry point is a no-op after dispose, so a late frame from a stalled
    // rAF cannot resurrect the field.
    starfield.update(1 / 60, 20, 4)
    starfield.setTheme(true)
    starfield.setReducedMotion(true)
    starfield.dispose()
    expect(starfield.object.children.length).toBe(0)
  })
})
