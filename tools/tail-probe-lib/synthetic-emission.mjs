/**
 * A synthetic frame built from the DOCUMENTED emission model, as the positive
 * control for the shape gates.
 *
 * Why this exists: the off-line self-test already anchors the positive side with two
 * real screenshots, but those come from the engine under test. A positive control
 * derived independently shows the gates are not merely "anything the engine draws
 * passes" — they encode a shape, and this shape (emitted matter with a lifetime) is
 * the one they accept.
 *
 * The model, transcribed from `writeTailParticlePosition`:
 *     p(t) = head + dir * reach * (t / life),     brightness = (1 - t/life) ^ 0.6
 * Emission at a constant rate means the number of particles alive per unit of axis is
 * proportional to 1/speed, so the axial DENSITY is flat and the brightness profile is
 * the fade alone. That is the whole difference between this and `drawNoFadePlume`:
 * one has a lifetime, the other is a cone parked on a line.
 */
import { encodePng } from './png.mjs'

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
 * @param g {
 *   w, h, hx, hy, ax, ay,        viewport and the projected nucleus/axis
 *   pxPerWorld,                  how many screenshot pixels one world unit spans
 *   reachMin, reachMax,          world units, from TAIL_DUST_REACH_*
 *   fadePower,                   TAIL_FADE_POWER
 *   count, halfAngle, brightness
 *   density                      particles per px^2 of projected tail area
 * }
 *
 * `count` and `density` are alternatives: give `count` for a fixed number, or
 * `density` to hold the particle density constant as the viewport changes. Density is
 * the right control when the SAME model is drawn at several viewports, because the
 * synthetic writes each particle with a max() (a point cloud does not add), so a fixed
 * count drawn over a shorter axis saturates and flattens the profile — which would make
 * the positive control fail for a reason that has nothing to do with the gates.
 */
export function drawEmissionPlume(g) {
  const w = Math.round(g.w)
  const h = Math.round(g.h)
  const rgb = Buffer.alloc(w * h * 3)
  const rnd = mulberry(0x1234)
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
  const reachMin = g.reachMin === undefined ? 7.5 : g.reachMin
  const reachMax = g.reachMax === undefined ? 13.0 : g.reachMax
  const fadePower = g.fadePower === undefined ? 0.6 : g.fadePower
  const halfAngle = g.halfAngle === undefined ? 0.215 : g.halfAngle
  const bright = g.brightness === undefined ? 232 : g.brightness
  // Area of the projected tail wedge: length x mean width.
  const area = g.tmax * (halfAngle * g.tmax)
  const count = g.density === undefined
    ? (g.count === undefined ? 24000 : g.count)
    : Math.max(500, Math.round(g.density * area))

  for (let i = 0; i < count; i++) {
    // Uniform in age -> the constant-emission-rate population. Each particle carries
    // its own reach, which is what makes the fade edge coherent instead of a hard rim.
    const u = rnd()
    const reach = reachMin + (reachMax - reachMin) * rnd()
    const along = reach * u * g.pxPerWorld
    const fade = Math.pow(1 - u, fadePower)
    if (fade <= 0) continue
    // Ejection cone, re-referenced per particle.
    const ang = rnd() * Math.PI * 2
    const rad = Math.sqrt(rnd()) * halfAngle * along
    const s = Math.cos(ang) * rad
    const n = Math.sin(ang) * rad
    const x = Math.round(g.hx + g.ax * along - g.ay * s)
    const y = Math.round(g.hy + g.ay * along + g.ax * s)
    if (x < 0 || y < 0 || x >= w || y >= h) continue
    const o = (y * w + x) * 3
    const v = Math.min(255, Math.round(bright * fade))
    // A point cloud writes per particle; overlapping points do not sum, so take max.
    if (rgb[o] < v) {
      rgb[o] = v
      rgb[o + 1] = Math.min(255, Math.round(v * 1.04))
      rgb[o + 2] = Math.min(255, Math.round(v * 1.16))
    }
  }
  // The nucleus: a dense bright ball, drawn last as the real one is brightest.
  const headR = g.headPx === undefined ? 9 : g.headPx
  for (let dy = -headR; dy <= headR; dy++) {
    for (let dx = -headR; dx <= headR; dx++) {
      if (dx * dx + dy * dy > headR * headR) continue
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
