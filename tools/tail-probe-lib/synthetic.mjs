/**
 * Synthetic frames drawn in Node, so the §1d criterion has a negative control whose
 * ground truth is known by construction rather than asserted by whoever wrote the
 * engine.
 *
 * `drawNoFadePlume` is the V1 shape the user rejected: a cone of constant surface
 * brightness along its whole length that stops dead at the end. If the pixel gates
 * accept that, they would have accepted the old tail, and they are worthless.
 */
import { encodePng } from './png.mjs'
import { drawEmissionPlume } from './synthetic-emission.mjs'

/** Deterministic PRNG, so a synthetic control is byte-identical between runs. */
function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A rigid, non-fading cone on the given axis, over the same starfield-like noise the
 * real frames sit on.
 *
 * @param g { hx, hy, ax, ay, tmax, w, h, halfAngle, brightness }
 */
export function drawNoFadePlume(g) {
  const w = Math.round(g.w)
  const h = Math.round(g.h)
  const rgb = Buffer.alloc(w * h * 3)
  const rnd = mulberry(0x5eed)
  // A sparse field of faint stars, matching the real frames' background level.
  rgb.fill(6)
  for (let i = 0; i < 900; i++) {
    const v = 40 + rnd() * 130
    const x = (rnd() * w) | 0
    const y = (rnd() * h) | 0
    const o = (y * w + x) * 3
    rgb[o] = v
    rgb[o + 1] = v
    rgb[o + 2] = v
  }
  const bright = g.brightness === undefined ? 214 : g.brightness
  const halfAngle = g.halfAngle === undefined ? 0.16 : g.halfAngle
  const steps = Math.round(g.tmax)
  for (let t = 0; t < steps; t++) {
    const hw = Math.max(1, halfAngle * t)
    for (let s = -hw; s <= hw; s += 0.5) {
      const x = Math.round(g.hx + g.ax * t - g.ay * s)
      const y = Math.round(g.hy + g.ay * t + g.ax * s)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const o = (y * w + x) * 3
      // CONSTANT surface brightness along the whole axis: no fade at all.
      rgb[o] = bright
      rgb[o + 1] = Math.min(255, bright + 11)
      rgb[o + 2] = Math.min(255, bright + 41)
    }
  }
  // A bright head, as a real comet has.
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      if (dx * dx + dy * dy > 64) continue
      const x = Math.round(g.hx + dx)
      const y = Math.round(g.hy + dy)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const o = (y * w + x) * 3
      rgb[o] = 255
      rgb[o + 1] = 255
      rgb[o + 2] = 255
    }
  }
  return encodePng(w, h, rgb)
}

/**
 * Particles per px^2 of projected tail area, tuned so the control is comparable to the
 * real engine's own tail density (~15000 tail particles over a ~51000 px^2 wedge at
 * 1440x900) and dense enough that the profile is not read as noise.
 */
export const CONTROL_DENSITY = 0.80

/**
 * Convenience: a control frame for a given live geometry, at a viewport-independent
 * density. Use this rather than a raw `count` so the same model is comparable across
 * the four viewports.
 */
export function emissionControlFrame(g) {
  return drawEmissionPlume({ ...g, density: CONTROL_DENSITY })
}

/** The same cone, but WITH the fade. Used to show the gates separate the two shapes. */
export function drawRigidCone(g) {
  const w = Math.round(g.w)
  const h = Math.round(g.h)
  const rgb = Buffer.alloc(w * h * 3)
  const rnd = mulberry(0xbeef)
  rgb.fill(6)
  for (let i = 0; i < 900; i++) {
    const v = 40 + rnd() * 130
    const x = (rnd() * w) | 0
    const y = (rnd() * h) | 0
    const o = (y * w + x) * 3
    rgb[o] = v
    rgb[o + 1] = v
    rgb[o + 2] = v
  }
  const bright = g.brightness === undefined ? 214 : g.brightness
  const halfAngle = g.halfAngle === undefined ? 0.16 : g.halfAngle
  for (let t = 0; t < g.tmax; t++) {
    const u = t / g.tmax
    const fade = Math.pow(1 - u, 0.6)
    const hw = Math.max(1, halfAngle * t)
    for (let s = -hw; s <= hw; s += 0.5) {
      const x = Math.round(g.hx + g.ax * t - g.ay * s)
      const y = Math.round(g.hy + g.ay * t + g.ax * s)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const o = (y * w + x) * 3
      rgb[o] = Math.round(bright * fade)
      rgb[o + 1] = Math.round(Math.min(255, bright + 11) * fade)
      rgb[o + 2] = Math.round(Math.min(255, bright + 41) * fade)
    }
  }
  return encodePng(w, h, rgb)
}

/** Convenience: the geometry a synthetic frame needs, from a live geometry reading. */
export function makeViewportLike(geom, w, h) {
  return {
    w, h, hx: geom.nucleus[0], hy: geom.nucleus[1],
    ax: geom.axis[0], ay: geom.axis[1], tmax: geom.projP97,
  }
}
