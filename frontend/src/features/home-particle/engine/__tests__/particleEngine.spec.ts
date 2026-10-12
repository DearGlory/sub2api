import { describe, expect, it } from 'vitest'
import { AdditiveBlending, NormalBlending } from 'three'

import {
  createEmissionTable,
  createEngineScratch,
  fillEmissionTable,
  followSpeedFor,
  glyphMixFor,
  paletteFor,
  tailFade,
  writeTailParticlePosition,
} from '../ParticleEngine'
import { createChoreography } from '../choreography'
import {
  BRANDS,
  HEAD_CORE_SHARE,
  POINTER_RADIUS,
  TAIL_DUST_LIFE_MIN,
  TAIL_DUST_REACH_MAX,
  TAIL_ENTRAIN,
  TAIL_FADE_POWER,
  TAIL_ION_LIFE_MAX,
  TAIL_ION_SHARE,
  TAIL_RADIUS,
  TAIL_SECONDS,
  TAIL_SPREAD,
} from '../constants'

/**
 * The engine owns a WebGL context, and jsdom does not have one — so a test that
 * merely constructed it would either fail, or (worse) pass by falling into the
 * shell's catch block, which is green while asserting nothing.
 *
 * This file therefore pins the logic that is real without a GPU: the emission model's
 * arithmetic, the buffers it reads, and the phase blending around it. The things that
 * need a context — the draw call, the frame pacing, the heap, and whether the plume
 * actually *looks* like a comet — are measured by `tools/visual-acceptance.mjs`
 * against real Chrome, because a stubbed renderer here would only be testing the stub.
 *
 * V2 note: the old tail was a rigid ribbon of particles pinned to arc-length slots.
 * The user rejected it as unreadable ("彗星和彗尾看不出来是什么东西"). The tests that
 * pinned that model — `tailT`, `tailRadius`, `accumulateArcLength`,
 * `resampleByArcLength` — are gone with it, and the tests below pin the properties
 * that replaced them: age, life, reach, the ejection cone, and the fade.
 */

const COUNT = 512
const TAIL_SAMPLES = 32

describe('createEngineScratch', () => {
  const scratch = createEngineScratch(COUNT, TAIL_SAMPLES)
  const coreCount = Math.floor(COUNT * HEAD_CORE_SHARE)

  it('allocates every buffer the frame loop needs, at the right length', () => {
    expect(scratch.positions.length).toBe(COUNT * 3)
    expect(scratch.velocities.length).toBe(COUNT * 3)
    expect(scratch.colors.length).toBe(COUNT * 4)
    expect(scratch.glyphTargets.length).toBe(COUNT * 3)
    expect(scratch.glyphStrokeDepth.length).toBe(COUNT)
    expect(scratch.tailAge.length).toBe(COUNT)
    expect(scratch.tailLife.length).toBe(COUNT)
    expect(scratch.tailReach.length).toBe(COUNT)
    expect(scratch.tailCone.length).toBe(COUNT * 3)
    expect(scratch.tailIon.length).toBe(COUNT)
    expect(scratch.tailSeed.length).toBe(COUNT)
    expect(scratch.headOffset.length).toBe(COUNT * 3)
    expect(scratch.iconOrbitOffsets.length).toBe(COUNT * 3)
  })

  it('allocates the emission table off the sample count the profile gives it', () => {
    expect(scratch.tailTable.probeCount).toBe(TAIL_SAMPLES)
    for (const buf of [
      scratch.tailTable.xyz,
      scratch.tailTable.vel,
      scratch.tailTable.axis,
      scratch.tailTable.side1,
      scratch.tailTable.side2,
    ]) {
      expect(buf.length).toBe(TAIL_SAMPLES * 3)
    }
    expect(scratch.tailTable.spanSeconds).toBe(TAIL_SECONDS)
  })

  it('starts every particle somewhere finite, so frame one cannot render NaN', () => {
    for (const buf of [
      scratch.positions,
      scratch.velocities,
      scratch.colors,
      scratch.tailCone,
      scratch.tailAge,
      scratch.tailLife,
      scratch.tailReach,
      scratch.headOffset,
    ]) {
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i]), `non-finite at ${i}: ${buf[i]}`).toBe(true)
      }
    }
  })

  it('packs a head core that never ages and never flies', () => {
    // The core is the nucleus: if it were emitted like the tail, the comet would
    // evaporate and the head would stop reading as a solid body.
    expect(coreCount).toBeGreaterThan(0)
    for (let i = 0; i < coreCount; i++) {
      expect(scratch.tailLife[i]).toBe(0)
      expect(scratch.tailReach[i]).toBe(0)
    }
  })

  it('gives every tail particle a positive life inside the designed window', () => {
    for (let i = coreCount; i < COUNT; i++) {
      expect(scratch.tailLife[i]).toBeGreaterThanOrEqual(TAIL_DUST_LIFE_MIN)
      expect(scratch.tailLife[i]).toBeLessThanOrEqual(TAIL_ION_LIFE_MAX)
      expect(scratch.tailReach[i]).toBeGreaterThan(0)
    }
  })

  it('starts every tail particle at a distinct age, so the plume is not one slab', () => {
    // All-zero ages would open the page with one synchronised wave of newborns that
    // all die together 2.5 s later — a visible pulse at first paint.
    const ages = Array.from(scratch.tailAge).slice(coreCount)
    expect(ages.every((a) => a >= 0)).toBe(true)
    const distinct = new Set(ages.map((a) => a.toFixed(5))).size
    expect(distinct).toBeGreaterThan(ages.length * 0.95)
    // ...and they must span the range, not merely be distinct.
    const spread = Math.max(...ages) - Math.min(...ages)
    expect(spread).toBeGreaterThan(TAIL_DUST_LIFE_MIN * 0.8)
  })

  it('keeps every emission cone direction a unit vector', () => {
    // The cone is baked as (cos θ, sin θ cos φ, sin θ sin φ) in the birth frame. If it
    // were not unit length, `reach` would stop meaning world units and the plume's
    // length would be whatever the hashes happened to produce.
    for (let i = coreCount; i < COUNT; i++) {
      const x = scratch.tailCone[i * 3]
      const y = scratch.tailCone[i * 3 + 1]
      const z = scratch.tailCone[i * 3 + 2]
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5)
    }
  })

  it('points every cone backward along its own axis, within the designed angle', () => {
    for (let i = coreCount; i < COUNT; i++) {
      const cosTheta = scratch.tailCone[i * 3]
      // `sin θ = TAIL_SPREAD * u^TAIL_FILL` with `u` in [0, 1], so `cos θ` sits in
      // [sqrt(1 - TAIL_SPREAD^2), 1] and the axial component is never negative — no
      // particle is ever ejected forward, into the direction of travel.
      expect(cosTheta).toBeGreaterThan(0)
      expect(cosTheta).toBeLessThanOrEqual(1)
      expect(cosTheta).toBeGreaterThanOrEqual(Math.sqrt(1 - TAIL_SPREAD * TAIL_SPREAD) - 1e-6)
    }
  })

  it('crowds the cone toward its axis, so the plume has a spine', () => {
    // `TAIL_FILL > 1` on `sin θ`. A uniform roll in `sin θ` would shell the cone and
    // the tail would read as concentric outlines rather than as a plume with a core.
    const sines = []
    for (let i = coreCount; i < COUNT; i++) {
      const c = scratch.tailCone[i * 3]
      sines.push(Math.sqrt(Math.max(0, 1 - c * c)))
    }
    const mean = sines.reduce((a, b) => a + b, 0) / sines.length
    // A uniform distribution over the cone would average TAIL_SPREAD / 2; crowding
    // toward the axis has to bring that mean down appreciably.
    expect(mean).toBeLessThan(TAIL_SPREAD * 0.45)
    // ...but the envelope must still exist, or the cone is a needle again.
    expect(Math.max(...sines)).toBeGreaterThan(TAIL_SPREAD * 0.6)
  })

  it('mixes a real ion population in with the dust', () => {
    let ion = 0
    for (let i = coreCount; i < COUNT; i++) ion += scratch.tailIon[i]
    const share = ion / (COUNT - coreCount)
    expect(share).toBeGreaterThan(TAIL_ION_SHARE - 0.08)
    expect(share).toBeLessThan(TAIL_ION_SHARE + 0.08)
  })

  it('reaches further with the ion population than with the dust', () => {
    // The one structural difference the brief asks for that survives at this
    // resolution: the straight tail overhangs the curving one.
    let dustReach = 0
    let ionReach = 0
    let dustN = 0
    let ionN = 0
    for (let i = coreCount; i < COUNT; i++) {
      if (scratch.tailIon[i]) {
        ionReach += scratch.tailReach[i]
        ionN += 1
      } else {
        dustReach += scratch.tailReach[i]
        dustN += 1
      }
    }
    expect(ionN).toBeGreaterThan(0)
    expect(dustN).toBeGreaterThan(0)
    expect(ionReach / ionN).toBeGreaterThan(dustReach / dustN)
  })

  it('wires the pointer field to the frozen radius constant', () => {
    expect(scratch.pointerField.radius).toBe(POINTER_RADIUS)
    expect(scratch.pointerField.radiusSq).toBe(POINTER_RADIUS * POINTER_RADIUS)
  })

  it('starts with the hold pose fully faded out', () => {
    // A non-zero toneScale at frame one would shade a comet as if it were a glyph.
    expect(scratch.iconHoldPose.toneScale).toBe(0)
    expect(scratch.iconHoldPose.rotationX).toBe(0)
    expect(scratch.iconHoldPose.rotationY).toBe(0)
    expect(scratch.iconHoldPose.rotationZ).toBe(0)
  })

  it('decorrelates life, reach and the cone from each other', () => {
    // The bug this file has already shipped once: every attribute derived from the same
    // golden-ratio sequence, so they were all functions of one another and the tail
    // rendered as a machined helix. Two independent hashes must not correlate.
    const n = 4000
    const s = createEngineScratch(n, 16)
    const core = Math.floor(n * HEAD_CORE_SHARE)
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y, 0) / a.length
      const mb = b.reduce((x, y) => x + y, 0) / b.length
      let cov = 0
      let va = 0
      let vb = 0
      for (let i = 0; i < a.length; i++) {
        const da = a[i] - ma
        const db = b[i] - mb
        cov += da * db
        va += da * da
        vb += db * db
      }
      return cov / Math.sqrt(va * vb)
    }

    // Life, reach and the cone must be independent *within a population*, so the test
    // separates the two populations rather than mixing them. Mixing them hides a real
    // signal as noise: an ion particle is both longer-reaching and narrower-coned by
    // design, so across the whole set `reach` and `coneX` correlate at ~0.17 — which is
    // the ion class, not a hash defect. Within dust, and within ion, all three pairs are
    // independent, and *that* is the property that matters: if the cone were derived
    // from the reach roll, every long particle would be a wide one and the plume's
    // envelope would be a cone shell instead of a plume.
    for (const wantIon of [0, 1]) {
      const life: number[] = []
      const reach: number[] = []
      const coneX: number[] = []
      for (let i = core; i < n; i++) {
        if (s.tailIon[i] !== wantIon) continue
        life.push(s.tailLife[i])
        reach.push(s.tailReach[i])
        coneX.push(s.tailCone[i * 3])
      }
      expect(life.length).toBeGreaterThan(200)
      expect(Math.abs(corr(life, reach))).toBeLessThan(0.12)
      expect(Math.abs(corr(life, coneX))).toBeLessThan(0.12)
      expect(Math.abs(corr(reach, coneX))).toBeLessThan(0.12)
    }
  })
})

describe('tailFade', () => {
  it('is bright at birth and exactly zero at the end of life', () => {
    // Exactly zero, not nearly: a recycled particle is evaluated at `u` just past 1 on
    // the frame it is reused, and anything other than 0 here would pop.
    expect(tailFade(0)).toBe(1)
    expect(tailFade(1)).toBe(0)
    expect(tailFade(1.5)).toBe(0)
    expect(tailFade(Number.NaN)).toBe(0)
  })

  it('decreases monotonically, so nothing brightens as it dies', () => {
    let previous = Infinity
    for (let k = 0; k <= 100; k++) {
      const v = tailFade(k / 100)
      expect(v).toBeLessThanOrEqual(previous)
      previous = v
    }
  })

  it('declines gradually rather than holding and then dropping', () => {
    // The user's requirement is a fade to nothing, not a cut. At the halfway point a
    // fade is still substantially visible; the exact value is the chosen exponent.
    expect(tailFade(0.5)).toBeCloseTo(Math.pow(0.5, TAIL_FADE_POWER), 6)
    expect(tailFade(0.5)).toBeGreaterThan(0.5)
    expect(tailFade(0.9)).toBeGreaterThan(0)
    expect(tailFade(0.9)).toBeLessThan(0.35)
  })
})

describe('fillEmissionTable', () => {
  /**
   * A synthetic path so the table can be checked without a choreography: the head
   * walks along +X at a constant speed. Expected values are then trivial to state, and
   * any sign error in the velocity or the axis shows up immediately.
   */
  function constantPath(speed: number) {
    return {
      sampleTrail(delay: number, target: { x: number; y: number; z: number }) {
        target.x = 10 - speed * delay
        target.y = 0
        target.z = 0
        return target
      },
    }
  }

  it('records the path newest-first at uniform time', () => {
    const table = createEmissionTable(17)
    fillEmissionTable(table, constantPath(2), { x: 0, y: 0, z: 0 })
    expect(table.xyz[0]).toBeCloseTo(10, 5)
    const step = TAIL_SECONDS / 16
    expect(table.xyz[3]).toBeCloseTo(10 - 2 * step, 5)
    expect(table.xyz[16 * 3]).toBeCloseTo(10 - 2 * TAIL_SECONDS, 5)
  })

  it('stores the FORWARD head velocity, not the backward one', () => {
    // This sign is the single most dangerous thing in the emission model. Stored
    // backwards, `birthPos + vel * age` puts every particle ahead of the comet and the
    // plume emerges from the nose, which reads as a shockwave rather than a tail.
    const table = createEmissionTable(17)
    fillEmissionTable(table, constantPath(2), { x: 0, y: 0, z: 0 })
    for (let k = 0; k < 17; k++) {
      expect(table.vel[k * 3], `probe ${k}`).toBeCloseTo(2, 4)
      expect(table.vel[k * 3 + 1]).toBeCloseTo(0, 6)
      expect(table.vel[k * 3 + 2]).toBeCloseTo(0, 6)
    }
  })

  it('points the ejection axis backward, opposite the velocity', () => {
    const table = createEmissionTable(17)
    fillEmissionTable(table, constantPath(2), { x: 0, y: 0, z: 0 })
    for (let k = 0; k < 17; k++) {
      // A head moving +X sheds its tail along -X.
      expect(table.axis[k * 3], `probe ${k}`).toBeCloseTo(-1, 5)
      expect(table.axis[k * 3 + 1]).toBeCloseTo(0, 6)
      expect(table.axis[k * 3 + 2]).toBeCloseTo(0, 6)
    }
  })

  it('builds an orthonormal basis at every probe, normal to the axis', () => {
    // The cone is expressed in this basis. A basis that is not orthonormal would skew
    // the cone into an ellipse, and one that is not unit length would scale `reach`.
    const table = createEmissionTable(33)
    fillEmissionTable(table, constantPath(3), { x: 0, y: 0, z: 0 })
    for (let k = 0; k < 33; k++) {
      const a = [table.axis[k * 3], table.axis[k * 3 + 1], table.axis[k * 3 + 2]]
      const s1 = [table.side1[k * 3], table.side1[k * 3 + 1], table.side1[k * 3 + 2]]
      const s2 = [table.side2[k * 3], table.side2[k * 3 + 1], table.side2[k * 3 + 2]]
      const len = (v: number[]) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
      const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
      expect(len(a), `axis ${k}`).toBeCloseTo(1, 5)
      expect(len(s1), `side1 ${k}`).toBeCloseTo(1, 5)
      expect(len(s2), `side2 ${k}`).toBeCloseTo(1, 5)
      expect(dot(a, s1), `axis·side1 ${k}`).toBeCloseTo(0, 5)
      expect(dot(a, s2), `axis·side2 ${k}`).toBeCloseTo(0, 5)
      expect(dot(s1, s2), `side1·side2 ${k}`).toBeCloseTo(0, 5)
    }
  })

  it('copes with a stationary head instead of dividing by zero', () => {
    // A held glyph pins the head, so its velocity is genuinely zero. The axis is then
    // undefined and the table must still be finite and unit-length.
    const table = createEmissionTable(9)
    fillEmissionTable(
      table,
      {
        sampleTrail(_delay: number, target: { x: number; y: number; z: number }) {
          target.x = 4
          target.y = -1
          target.z = 2
          return target
        },
      },
      { x: 0, y: 0, z: 0 }
    )
    for (let k = 0; k < 9; k++) {
      const ax = table.axis[k * 3]
      const ay = table.axis[k * 3 + 1]
      const az = table.axis[k * 3 + 2]
      expect(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az)).toBe(true)
      expect(Math.sqrt(ax * ax + ay * ay + az * az)).toBeCloseTo(1, 5)
    }
  })

  it('writes nothing outside the table for any probe count a profile can ask for', () => {
    for (const n of [2, 3, 8, 48, 96, 200]) {
      const table = createEmissionTable(n)
      fillEmissionTable(table, constantPath(1), { x: 0, y: 0, z: 0 })
      for (const buf of [table.xyz, table.vel, table.axis, table.side1, table.side2]) {
        for (let i = 0; i < buf.length; i++) {
          expect(Number.isFinite(buf[i]), `n=${n} index=${i}`).toBe(true)
        }
      }
    }
  })

  it('allocates nothing across repeated refills', () => {
    // The frame loop calls this every frame. A fresh Float32Array per call would be
    // ~5 KB of garbage at 60 Hz, which is exactly what §6 item 2 forbids.
    const table = createEmissionTable(96)
    const source = constantPath(2)
    const point = { x: 0, y: 0, z: 0 }
    fillEmissionTable(table, source, point)
    const snapshot = Array.from(table.xyz)
    for (let f = 0; f < 5; f++) fillEmissionTable(table, source, point)
    expect(Array.from(table.xyz)).toEqual(snapshot)
    // The buffers are the same objects throughout, not replacements.
    expect(table.xyz).toBeInstanceOf(Float32Array)
    expect(table.xyz.length).toBe(96 * 3)
  })
})

describe('writeTailParticlePosition', () => {
  /** A head cruising along +X at 4 units/s, tabulated. */
  function cruisingTable(probes = 65) {
    const table = createEmissionTable(probes)
    fillEmissionTable(
      table,
      {
        sampleTrail(delay: number, target: { x: number; y: number; z: number }) {
          target.x = 6 - 4 * delay
          target.y = 0
          target.z = 0
          return target
        },
      },
      { x: 0, y: 0, z: 0 }
    )
    return table
  }

  const out = new Float32Array(3)

  it('emits particles behind the nucleus, never ahead of it', () => {
    // The whole point of the model. A particle must be shed backward.
    const table = cruisingTable()
    for (const age of [0.2, 0.8, 1.6, 2.4]) {
      const life = 2.5
      writeTailParticlePosition(table, age, life, 10, 1, 0, 0, 0, 0, 0, out)
      expect(out[0], `age=${age}`).toBeLessThan(table.xyz[0])
    }
  })

  it('starts at the nucleus and moves monotonically away from it', () => {
    const table = cruisingTable()
    const life = 2.5
    let previous = -Infinity
    for (let k = 0; k <= 20; k++) {
      const age = (k / 20) * life
      writeTailParticlePosition(table, age, life, 10, 1, 0, 0, 0, 0, 0, out)
      const travelled = table.xyz[0] - out[0]
      expect(travelled).toBeGreaterThanOrEqual(previous - 1e-5)
      previous = travelled
    }
    // At birth the particle is at the head.
    writeTailParticlePosition(table, 0, life, 10, 1, 0, 0, 0, 0, 0, out)
    expect(out[0]).toBeCloseTo(table.xyz[0], 3)
  })

  it('is exactly `reach` behind the head plus the un-inherited head travel', () => {
    // The load-bearing identity of the whole model, and the one worth pinning:
    //
    //   distance behind the head = headTravel·(1 - TAIL_ENTRAIN) + reach
    //
    // Read it at ENTRAIN = 1 and the headTravel term vanishes — the plume's length is
    // `reach` alone, independent of how fast the head is moving. That is the property
    // the old rigid arc-length tail was built to fake, and this is where it comes from
    // for real. At the shipped 0.25 a quarter of the head's motion is inherited, so the
    // length keeps a mild dependence on head speed, which is what stops the plume
    // smearing tangent to the S-curve.
    const table = cruisingTable()
    const life = 2.0
    const reach = 9
    writeTailParticlePosition(table, life, life, reach, 1, 0, 0, 0, 0, 0, out)
    const behind = table.xyz[0] - out[0]
    // The head cruises at 4 u/s, so over `life` seconds it covers 8 units; the birth
    // probe is that far back along the path.
    const headTravel = 4 * life
    expect(behind).toBeCloseTo(headTravel * (1 - TAIL_ENTRAIN) + reach, 3)
  })

  it('scales the emitted distance one-for-one with reach', () => {
    // Isolating `reach`: at the end of life the displacement along the birth axis *is*
    // the reach, so two particles that differ only in reach differ in position by
    // exactly that difference. This is the invariant the note on `TAIL_DUST_REACH_MIN`
    // promises — length is a property of `reach` alone, never of `life`.
    const table = cruisingTable()
    const a = new Float32Array(3)
    const b = new Float32Array(3)
    // age === life, so `age / life` is 1 and the emission term is the full reach.
    writeTailParticlePosition(table, 2.0, 2.0, 5, 1, 0, 0, 0, 0, 0, a)
    writeTailParticlePosition(table, 2.0, 2.0, 10, 1, 0, 0, 0, 0, 0, b)
    // The cone is (1, 0, 0) and the newest backward axis is (-1, 0, 0), so the extra 5
    // units of reach move the particle 5 units further back.
    expect(a[0] - b[0]).toBeCloseTo(5, 4)
  })

  it('scales the emitted distance with the fraction of life elapsed, not with life', () => {
    // The complement of the check above, and the reason `reach` rather than a speed is
    // what gets baked: at a *given* fraction of life, two particles with different
    // lifetimes but the same reach sit at the same distance. If speed were baked instead,
    // the long-lived one would be further out and the far end of the plume would be built
    // only from long-lived particles — a visible stratification.
    const table = cruisingTable()
    const a = new Float32Array(3)
    const b = new Float32Array(3)
    // Same fraction (0.5), same reach, different lifetimes.
    writeTailParticlePosition(table, 0.5, 1.0, 8, 1, 0, 0, 0, 0, 0, a)
    writeTailParticlePosition(table, 1.5, 3.0, 8, 1, 0, 0, 0, 0, 0, b)
    // Both cover half their reach, so their emitted displacements differ only by the
    // entrainment term, which is `headSpeed · (ageB - ageA) · (1 - TAIL_ENTRAIN)`.
    const emittedA = table.xyz[0] - a[0]
    const emittedB = table.xyz[0] - b[0]
    const headSpeed = 4
    const expectedGap = headSpeed * (1.5 - 0.5) * (1 - TAIL_ENTRAIN)
    expect(Math.abs(emittedA - emittedB)).toBeCloseTo(expectedGap, 3)
    // ...and the part that is *not* entrainment is identical: half the reach, in both.
    expect(emittedA - headSpeed * 0.5 * (1 - TAIL_ENTRAIN)).toBeCloseTo(4, 3)
    expect(emittedB - headSpeed * 1.5 * (1 - TAIL_ENTRAIN)).toBeCloseTo(4, 3)
  })

  it('keeps the plume length nearly independent of head speed', () => {
    // The regression guard for the defect that started this rewrite. The old rigid tail
    // existed because a time-keyed one stretched and collapsed with the head's speed;
    // the emission model has to reproduce that immunity. A slow head (1 u/s) and a fast
    // one (9 u/s) must produce plumes of comparable depth.
    const slow = cruisingTable()
    const fast = createEmissionTable(65)
    const birth = { x: 0, y: 0, z: 0 }
    const slowSource = {
      sampleTrail(delay: number, target: { x: number; y: number; z: number }) {
        target.x = 6 - 1 * delay
        target.y = 0
        target.z = 0
        return target
      },
    }
    const fastSource = {
      sampleTrail(delay: number, target: { x: number; y: number; z: number }) {
        target.x = 6 - 9 * delay
        target.y = 0
        target.z = 0
        return target
      },
    }
    fillEmissionTable(slow, slowSource, birth)
    fillEmissionTable(fast, fastSource, birth)
    const life = 2.0
    writeTailParticlePosition(slow, life, life, 10, 1, 0, 0, 0, 0, 0, out)
    const slowDepth = slow.xyz[0] - out[0]
    writeTailParticlePosition(fast, life, life, 10, 1, 0, 0, 0, 0, 0, out)
    const fastDepth = fast.xyz[0] - out[0]
    // With no inheritance at all the ratio would be 9:1 (the speeds); with full
    // inheritance it would be 1:1. At 0.25 it must sit far closer to parity than to the
    // naive ratio — this is the quantitative version of "the tail keeps its shape
    // through the turn".
    const ratio = fastDepth / slowDepth
    expect(ratio).toBeLessThan(2.5)
    // ...and it must not have gone the other way and inverted the physics.
    expect(ratio).toBeGreaterThan(0.8)
  })

  it('opens a cone in the plane normal to the axis', () => {
    const table = cruisingTable()
    const life = 2.0
    // Pure sideways ejection: cone = (0, 1, 0), so the particle lands off-axis by its
    // full reach and does not advance along the travel direction at all.
    writeTailParticlePosition(table, life, life, 5, 0, 1, 0, 0, 0, 0, out)
    const lateral = Math.hypot(out[1] - table.xyz[1], out[2] - table.xyz[2])
    expect(lateral).toBeCloseTo(5, 3)
  })

  it('never writes a non-finite value, whatever it is handed', () => {
    const table = cruisingTable()
    for (const [age, life, reach] of [
      [0, 1, 1],
      [-5, 1, 1],
      [1e9, 1, 1],
      [1, 0, 5],
      [1, 1, 0],
      [Number.NaN, 1, 1],
      [1, 1, Number.NaN],
    ] as const) {
      writeTailParticlePosition(table, age, life, reach, 1, 0, 0, 0, 0, 0, out)
      for (let i = 0; i < 3; i++) {
        expect(
          Number.isFinite(out[i]),
          `age=${age} life=${life} reach=${reach} i=${i}`
        ).toBe(true)
      }
    }
  })

  it('clamps an age past the table instead of reading out of bounds', () => {
    // TAIL_SECONDS has to exceed the longest life precisely so this is unreachable in
    // normal travel; if it does become reachable, the tail must not read garbage.
    const table = cruisingTable(17)
    writeTailParticlePosition(table, TAIL_SECONDS * 10, 3, 5, 1, 0, 0, 0, 0, 0, out)
    expect(Number.isFinite(out[0])).toBe(true)
  })
})

describe('glyphMixFor', () => {
  it('is a pure comet while travelling', () => {
    expect(glyphMixFor('travel', 0)).toBe(0)
    expect(glyphMixFor('travel', 0.5)).toBe(0)
    expect(glyphMixFor('travel', 1)).toBe(0)
  })

  it('is a fully formed glyph throughout the hold', () => {
    expect(glyphMixFor('hold', 0)).toBe(1)
    expect(glyphMixFor('hold', 0.5)).toBe(1)
    expect(glyphMixFor('hold', 1)).toBe(1)
  })

  it('rises monotonically through the gather and ends fully formed', () => {
    let previous = -1
    for (let step = 0; step <= 20; step++) {
      const mix = glyphMixFor('gather', step / 20)
      expect(mix).toBeGreaterThanOrEqual(previous)
      previous = mix
    }
    expect(glyphMixFor('gather', 0)).toBeCloseTo(0, 6)
    expect(glyphMixFor('gather', 1)).toBeCloseTo(1, 6)
  })

  it('falls monotonically through the scatter and ends a pure comet', () => {
    let previous = 2
    for (let step = 0; step <= 20; step++) {
      const mix = glyphMixFor('scatter', step / 20)
      expect(mix).toBeLessThanOrEqual(previous)
      previous = mix
    }
    expect(glyphMixFor('scatter', 0)).toBeCloseTo(1, 6)
    expect(glyphMixFor('scatter', 1)).toBeCloseTo(0, 6)
  })

  it('hands over continuously at every phase boundary', () => {
    // gather(1) -> hold(0), hold(1) -> scatter(0) and scatter(1) -> travel(0) must
    // agree, or the shape jumps at the seam.
    expect(glyphMixFor('gather', 1)).toBeCloseTo(glyphMixFor('hold', 0), 6)
    expect(glyphMixFor('hold', 1)).toBeCloseTo(glyphMixFor('scatter', 0), 6)
    expect(glyphMixFor('scatter', 1)).toBeCloseTo(glyphMixFor('travel', 0), 6)
  })

  it('clamps out-of-range progress instead of extrapolating', () => {
    expect(glyphMixFor('gather', -5)).toBe(0)
    expect(glyphMixFor('gather', 5)).toBe(1)
    expect(glyphMixFor('scatter', -5)).toBe(1)
    expect(glyphMixFor('scatter', 5)).toBe(0)
  })
})

describe('followSpeedFor', () => {
  it('holds the glyph with the stiffest spring, so it reads as solid', () => {
    expect(followSpeedFor('hold')).toBeGreaterThan(followSpeedFor('travel'))
    expect(followSpeedFor('hold')).toBeGreaterThan(followSpeedFor('scatter'))
  })

  it('travels with the loosest spring, so the comet streams rather than snaps', () => {
    expect(followSpeedFor('travel')).toBeLessThan(followSpeedFor('gather'))
    expect(followSpeedFor('travel')).toBeLessThan(followSpeedFor('hold'))
  })

  it('returns a finite positive step below 1 for every phase', () => {
    for (const phase of ['travel', 'gather', 'hold', 'scatter'] as const) {
      const value = followSpeedFor(phase)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
      // A step of 1 or more would jump straight to the target and oscillate.
      expect(value).toBeLessThan(1)
    }
  })
})

/**
 * Measure the live plume the way the acceptance data does, using the real model and
 * the real choreography.
 *
 * This is the replacement for the old arc-length assertions. It does not *look* at
 * anything — jsdom has no GPU — but it runs the same arithmetic the engine runs, over
 * the same baked buffers, against the actual S-curve, and bins the result by distance
 * along the tail axis. That is enough to pin the two things the user's complaint was
 * about: that the plume falls off monotonically and reaches ~0, and that the particle
 * ages are spread rather than synchronised.
 *
 * `phaseSeconds` is the clock offset into the beat, so a test can sample the middle of
 * a travel leg (where the comet is a comet) rather than a hold.
 */
function measurePlume(phaseSeconds = 4.0, count = 18000, probes = 96) {
  const scratch = createEngineScratch(count, probes)
  const choreography = createChoreography({
    brandCount: 28,
    amplitudeX: 9,
    swayY: 1.6,
    swayZ: 2.2,
    legSeconds: 6.5,
    gatherSeconds: 1.4,
    holdSeconds: 3,
    scatterSeconds: 1.1,
  })
  choreography.update(phaseSeconds)
  fillEmissionTable(scratch.tailTable, choreography, scratch.probePoint)

  const table = scratch.tailTable
  const head = { x: table.xyz[0], y: table.xyz[1], z: table.xyz[2] }
  // The axis is the table's own newest backward tangent — the same direction the
  // engine measures the plume along.
  const axis = { x: table.axis[0], y: table.axis[1], z: table.axis[2] }

  const BIN = 1
  const BINS = 24
  const luminosity = new Array(BINS).fill(0)
  const ages: number[] = []
  const axial: number[] = []
  const out = new Float32Array(3)

  const coreCount = Math.floor(count * HEAD_CORE_SHARE)
  for (let i = coreCount; i < count; i++) {
    const age = scratch.tailAge[i]
    const life = scratch.tailLife[i]
    writeTailParticlePosition(
      table,
      age,
      life,
      scratch.tailReach[i],
      scratch.tailCone[i * 3],
      scratch.tailCone[i * 3 + 1],
      scratch.tailCone[i * 3 + 2],
      scratch.headOffset[i * 3],
      scratch.headOffset[i * 3 + 1],
      scratch.headOffset[i * 3 + 2],
      out
    )
    const rx = out[0] - head.x
    const ry = out[1] - head.y
    const rz = out[2] - head.z
    const d = rx * axis.x + ry * axis.y + rz * axis.z

    const w = tailFade(life > 1e-6 ? age / life : 1)
    const bin = Math.floor(d / BIN)
    if (bin >= 0 && bin < BINS) luminosity[bin] += w
    ages.push(age / life)
    axial.push(d)
  }
  return { luminosity, ages, axial, BINS, BIN }
}

describe('the emitted plume has a comet shape', () => {
  const measured = measurePlume(4.0)

  it('fades monotonically from the nucleus outward', () => {
    // The user's requirement in one assertion: "达到一定距离后渐变消失". Every bin from
    // the nucleus outward must hold no more light than the one closer in. A bump
    // anywhere would read as a shell or a ring rather than as a plume.
    const { luminosity } = measured
    expect(luminosity[0]).toBeGreaterThan(0)
    let rises = 0
    for (let k = 1; k < luminosity.length; k++) {
      if (luminosity[k] > luminosity[k - 1] * 1.02) rises += 1
    }
    // Bin noise is allowed to wobble slightly; a real inversion is not. Two or three
    // bins out of 24 is noise at 18 000 samples.
    expect(rises, `luminosity profile: ${luminosity.map((v) => v.toFixed(0))}`).toBeLessThan(4)
  })

  it('reaches essentially zero at the tip, rather than being cut off', () => {
    const { luminosity } = measured
    const total = luminosity.reduce((a, b) => a + b, 0)
    const last = luminosity[luminosity.length - 1] / total
    expect(last).toBeLessThan(0.01)

    // And it must be a *gradual* decline, not a cliff: the bin where half the light
    // has gone has to sit well inside the plume, not at its edge.
    let cumulative = 0
    let medianBin = -1
    for (let k = 0; k < luminosity.length; k++) {
      cumulative += luminosity[k]
      if (medianBin < 0 && cumulative >= total / 2) medianBin = k
    }
    expect(medianBin).toBeGreaterThan(3)
    expect(medianBin).toBeLessThan(12)
  })

  it('spans roughly the designed visible length', () => {
    // The 1%-of-light contour, in world units along the tail axis. This is the measured
    // counterpart of `TAIL_DUST_REACH_MAX`.
    const { luminosity, BIN } = measured
    const total = luminosity.reduce((a, b) => a + b, 0)
    let cumulative = 0
    let onePercent = 0
    for (let k = 0; k < luminosity.length; k++) {
      cumulative += luminosity[k]
      if (cumulative / total <= 0.99) onePercent = (k + 1) * BIN
    }
    expect(onePercent).toBeGreaterThan(8)
    expect(onePercent).toBeLessThan(18)
  })

  it('holds a mixture of newborn, mid-life and dying particles at once', () => {
    // The property the rigid arc-length tail could not have and the reason this was
    // rewritten: a fixed slot was the same age forever. Every eighth of the lifetime
    // must be occupied, or the plume is a synchronised slab that breathes as one.
    const { ages } = measured
    const bins = new Array(8).fill(0)
    for (const u of ages) {
      bins[Math.min(7, Math.floor(u * 8))] += 1
    }
    const n = ages.length
    for (let k = 0; k < 8; k++) {
      expect(bins[k] / n, `bin ${k} of ${bins.map((b) => b.toFixed(0))}`).toBeGreaterThan(0.02)
    }
    // ...and no single eighth may dominate, which is what a shared lifetime produces.
    expect(Math.max(...bins) / n).toBeLessThan(0.35)
  })

  it('keeps the nucleus the widest, brightest part of the comet', () => {
    // The user's second complaint was that the comet had been made *smaller*. Nothing
    // in this rewrite may shrink it, so the near field must stay the densest part.
    const { luminosity } = measured
    const near = luminosity[0] + luminosity[1]
    const far = luminosity[luminosity.length - 2] + luminosity[luminosity.length - 1]
    expect(near).toBeGreaterThan(far * 20)
  })

  it('gives the plume a tip radius inside the required window', () => {
    // `r_tip = TAIL_RADIUS + TAIL_SPREAD * TAIL_DUST_REACH_MAX`, the derivation the
    // constants file states. 2.5-4.0 world units is the band the brief mandates: below
    // it the tail is a needle (the 0.123 era), above it the tail is a fog bank (the
    // 1.15 era).
    const tipRadius = TAIL_RADIUS + TAIL_SPREAD * TAIL_DUST_REACH_MAX
    expect(tipRadius).toBeGreaterThan(2.5)
    expect(tipRadius).toBeLessThan(4.0)
    // ...and the median particle must still be much closer to the axis than the edge,
    // or the cone has no core to catch the eye.
    expect(TAIL_RADIUS / tipRadius).toBeLessThan(0.2)
  })

  it('survives every phase of the beat without leaving the frame', () => {
    // The emission model has to behave at the extremes too: mid-leg, arriving, and
    // deep into a hold, when the head is pinned to the glyph's anchor and the tail has
    // no travel left to inherit. A blow-up here would be a comet that explodes once a
    // minute, which a screenshot at t = 4 s would never show.
    for (const phase of [0.5, 2.0, 4.0, 6.0, 6.4, 7.5, 9.0, 11.5]) {
      const m = measurePlume(phase, 4000, 48)
      for (const d of m.axial) {
        expect(Number.isFinite(d), `phase=${phase}`).toBe(true)
        expect(Math.abs(d), `phase=${phase} distance ${d}`).toBeLessThan(40)
      }
      const total = m.luminosity.reduce((a, b) => a + b, 0)
      expect(Number.isFinite(total), `phase=${phase}`).toBe(true)
    }
  })

  it('keeps the particle count unchanged, so nothing was made smaller', () => {
    // A cheap guard on the other half of the user's feedback: the rewrite must not have
    // quietly reduced how much material the comet is made of.
    const scratch = createEngineScratch(18000, 96)
    expect(scratch.tailLife.length).toBe(18000)
    expect(scratch.tailCone.length).toBe(18000 * 3)
    const tailParticles = 18000 - Math.floor(18000 * HEAD_CORE_SHARE)
    let alive = 0
    for (let i = 0; i < 18000; i++) {
      if (scratch.tailAge[i] < scratch.tailLife[i]) alive += 1
    }
    // Every tail particle is inside its own lifetime at construction.
    expect(tailParticles).toBeGreaterThan(14000)
    expect(alive).toBe(tailParticles)
  })
})

describe('the theme palettes', () => {
  /** WCAG relative luminance, on a 0..1 component. */
  const rel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const luminance = (rgb: { r: number; g: number; b: number }) =>
    0.2126 * rel(rgb.r) + 0.7152 * rel(rgb.g) + 0.0722 * rel(rgb.b)
  const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  const light = paletteFor(true)
  const dark = paletteFor(false)

  it('picks normal blending on the light theme and additive on the dark one', () => {
    // Additive on a pale page sums toward white and disappears. Getting this
    // backwards is the whole reason the light theme has its own palette.
    expect(light.blending).toBe(NormalBlending)
    expect(dark.blending).toBe(AdditiveBlending)
  })

  it('gives the light theme a pale clear colour, so the canvas sits behind the page', () => {
    // An opaque dark clear colour on the light theme would paint the entire page
    // over. The canvas is alpha-composited, so this is a real failure, not a nit.
    expect(luminance(light.background)).toBeGreaterThan(0.85)
    expect(luminance(dark.background)).toBeLessThan(0.05)
  })

  it('gives the light theme ink dark enough to read as the subject', () => {
    // Measured in a real browser: at core 0.16 / opacity 0.8 / size 0.082 the comet
    // came out at 2.85:1 against the page while its own starfield managed 6.78:1 —
    // the background out-shouted the subject. WCAG wants >= 3:1 for a non-text
    // graphic; this asserts a margin above that, because normal blending converges
    // on a haze rather than on the sprite's centre colour, so the rendered result is
    // always lighter than the vertex colour suggests.
    expect(contrast(light.core, light.background)).toBeGreaterThan(12)
  })

  it('keeps the light theme particles fully opaque and larger than the dark ones', () => {
    // Counter-intuitive but forced by the blending mode: additive light accumulates
    // as it overlaps, so the dark theme can afford a small faint sprite. Ink does
    // not accumulate, so each light-theme particle has to carry its own weight.
    expect(light.opacity).toBe(1)
    expect(light.pointSize).toBeGreaterThan(dark.pointSize)
    expect(dark.opacity).toBe(1)
  })

  it('keeps the accent the only saturated colour, on both themes', () => {
    // One warm accent is the design language's rule; a second saturated hue would
    // make the palette read as a scheme rather than as an accent.
    //
    // Measured as absolute chroma (max - min), not as a ratio. A ratio overstates
    // saturation for dark colours: the light theme's neutral ink sits at
    // (0.06, 0.075, 0.115), whose spread is 48% of its own brightness yet only 0.055
    // in absolute terms — the eye reads that as a dark grey, and a ratio-based test
    // would wrongly call it a second accent.
    for (const [name, p] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const chroma = (c: { r: number; g: number; b: number }) =>
        Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
      // A slight cast is deliberate — the dark theme's starlight is cool, the light
      // theme's ink is faintly blue — but it must stay an order of magnitude below
      // the accent, which is what "one accent" actually means here.
      expect(chroma(p.core), `${name} core should be near-neutral`).toBeLessThan(0.16)
      expect(chroma(p.accent), `${name} accent should be saturated`).toBeGreaterThan(0.4)
      expect(chroma(p.accent) / chroma(p.core), `${name} accent must dominate`).toBeGreaterThan(2.5)
    }
  })

  it('gives the dark theme near-white particles, so the comet reads as light', () => {
    expect(contrast(dark.core, dark.background)).toBeGreaterThan(12)
  })
})

describe('the brand roster', () => {
  it('has the 28 logos the user asked for, with unique slugs', () => {
    expect(BRANDS.length).toBe(28)
    const slugs = BRANDS.map((b) => b.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('includes every vendor the user named', () => {
    const slugs = new Set(BRANDS.map((b) => b.slug))
    for (const required of [
      'openai',
      // [user] Claude's own mark, not Anthropic's "A". The vendor the user named
      // here was the Claude line of models, and the logo they asked to see is
      // Claude's star mark, so the roster entry is `claude`. `anthropic` is not in
      // the list on purpose — see `constants.ts` and the asset directory, where
      // `anthropic.svg` was removed rather than left unused.
      'claude',
      'gemini',
      'grok',
      'deepseek',
      'zai',
      'kimi',
      'minimax',
      'xiaomimimo',
      'qwen',
      'bytedance',
      'meta',
    ]) {
      expect(slugs.has(required), `missing ${required}`).toBe(true)
    }
    // The superseded entry must not come back by accident: a stray `anthropic`
    // would resolve to a missing asset and fall back to the noise field, i.e. the
    // glyph would silently become a blob.
    expect(slugs.has('anthropic')).toBe(false)
  })

  it('gives every brand a label to show and a slug that maps to an asset', () => {
    for (const brand of BRANDS) {
      expect(brand.label.length).toBeGreaterThan(0)
      expect(brand.slug).toMatch(/^[a-z0-9]+$/)
    }
  })
})
