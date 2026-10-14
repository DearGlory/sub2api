/**
 * Discrimination proof: push deliberately WRONG data through the same checkers the
 * real data went through, and require every mutant to be REJECTED.
 *
 * This is the most important section of the probe. A checker with no teeth reports
 * PASS for a broken engine, which is worse than having no checker at all because it
 * manufactures confidence. So a mutant that is ACCEPTED fails the probe outright.
 *
 * Three kinds of mutant appear below:
 *   - SYNTHETIC: a spoofed implementation of the kernel (a fade that does not reach
 *     0, a fade that is not monotone, the old rigid position law).
 *   - REAL-PIXELS CONTROL: the actual rendered pixels, sampled on an axis rotated 90
 *     degrees from the plume. Same starfield, same background, no plume — so a probe
 *     that finds a plume there is measuring noise.
 *   - LIVE-CLOUD CONTROL: displacement fields built from the running page's own
 *     positions (a whole-cloud block flip), and the recording's own hold frames with
 *     a constant ramp added.
 */
import { checkFade, checkTable } from './checkers.mjs'
import { checkReachModel, checkPixelProfile } from './checkers-trail.mjs'
import { checkTransition, checkHold } from './checkers-motion.mjs'
import { profileSummary } from './png.mjs'

const fix = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : String(v))

/** Run one checker and report whether it rejected the mutant. */
function judge(rec, name, injectedFault, checkerName, res) {
  const bad = res.checks.filter((c) => !c.ok)
  const caughtBy = bad.map((c) => c.name + ' -> ' + c.detail)
  rec.push({
    name, injectedFault, checker: checkerName, rejected: bad.length > 0,
    evidence: bad.length ? caughtBy.join('; ') : 'NOT CAUGHT — the checker accepted it',
    gate: checkerName,
  })
}

/** §1a mutants: a broken fade. */
export function fadeMutants(record) {
  const pow = (u) => (u >= 1 ? 0 : Math.pow(1 - Math.max(0, u), 0.6))
  const list = [
    {
      name: 'tailFade returns 1 for a non-finite input',
      fault: 'a NaN lifetime leaves a permanently bright particle stuck in the plume instead of hiding it',
      fn: (u) => (Number.isFinite(u) ? pow(u) : 1),
    },
    {
      name: 'tailFade does not reach exactly 0 at u = 1',
      fault: 'the recycled particle is still visible on the frame it is reused, which is the flash the requirement forbids',
      fn: (u) => (u >= 1 ? 0.02 : pow(u)),
    },
    {
      name: 'tailFade is not monotone (a bright bump near u = 0.7)',
      fault: 'the fade is no longer gradual: the plume brightens again partway down its length',
      fn: (u) => pow(u) + 0.25 * Math.exp(-Math.pow((u - 0.7) / 0.08, 2)),
    },
  ]
  for (const m of list) {
    judge(record, m.name, m.fault, 'checkFade (§1a)', checkFade(m.fn, 'mutant'))
  }
}

/** §1b mutant: the old rigid-ribbon position law, with TAIL_ENTRAIN dropped. */
export function reachMutant(record, realData, C) {
  if (!realData) return
  // Re-derive the mutant measurement from the real one by removing the inherited
  // birth-velocity term the engine adds: |reach + V*life*(1 - entrain)| -> |reach + V*life|.
  const V = realData.V
  const faked = {
    V,
    still: realData.still,
    moving: realData.moving.map((x) => ({
      reach: x.reach, life: x.life,
      dEnd: Math.abs(x.reach + V * x.life),
      seq: x.seq,
    })),
  }
  judge(record,
    'writeTailParticlePosition without the inherited birth velocity',
    'drops the TAIL_ENTRAIN term: the plume stops co-moving with the head, which is the rigid-ribbon behaviour the user rejected',
    'checkReachModel (§1b)', checkReachModel(faked, C, 'mutant'))
}

/** §1b mutant: a particle that is parked on a pre-built cone instead of born at the head. */
export function birthMutant(record, realData, C) {
  if (!realData) return
  const faked = {
    V: realData.V,
    // The old rig placed the particle at its final slot from frame one, so the
    // "distance at age 0" is the full reach rather than ~0.
    still: realData.still.map((x) => ({ reach: x.reach, life: x.life, d0: x.reach, dEnd: x.dEnd })),
    moving: realData.moving,
  }
  judge(record,
    'writeTailParticlePosition starts the particle at the end of its reach',
    'the old static cone: every particle already sits at its final slot at age 0, so nothing is emitted from the comet',
    'checkReachModel (§1b)', checkReachModel(faked, C, 'mutant'))
}

/** §1c mutant: an emission table built from a path that diverges. */
export function tableMutant(record, table) {
  if (!table) return
  judge(record, 'emission table built from a path that diverges',
    'head position grows by 10^3 over the 3.2 s span, so the plume would smear across the whole scene',
    'checkTable (§1c)', checkTable(table, 'mutant'))
}

/** §1d mutants. `coneSummary` comes from the synthetic rigid cone image. */
export function pixelMutants(record, coneSummary, rotatedPeak, realPeak) {
  if (coneSummary) {
    judge(record,
      'rendered tail is a rigid cone of constant brightness with a hard end',
      'the synthetic control image: uniform surface brightness along the whole axis, then it stops dead — the V1 shape the user rejected',
      'checkPixelProfile (§1d)', checkPixelProfile(coneSummary, 'mutant'))
  }
  if (rotatedPeak !== undefined && rotatedPeak !== null && realPeak > 0) {
    // The real pixels, sampled on the azimuth 90 degrees off the plume. Build a
    // summary of the same shape from the rotated profile so the same checker runs.
    judge(record,
      'plume axis is wrong: the same real pixels sampled on an axis rotated 90 deg',
      'a probe that does not actually locate the plume would report brightness where there is none',
      'checkPixelProfile (§1d)', checkPixelProfile(rotatedPeak, 'mutant'))
  }
}

/** §2 mutant: a whole-cloud single-frame displacement field (block flip). */
export function transitionMutant(record, blockRows, idleP99) {
  if (!blockRows || !blockRows.length) return
  judge(record, 'the transition moves the whole cloud in one frame (block flip)',
    'every particle displaced by its full comet->glyph distance in a single frame',
    'checkTransition (§2)', checkTransition(blockRows.concat(blockRows), 'mutant', idleP99))
}

/** §3 mutants: a drift during the hold, and a hold of the wrong length. */
export function holdMutants(record, runs, holdSeconds) {
  if (runs && runs.length) {
    const drifted = runs.map((w) => ({
      frames: w.frames.map((f, i) => ({ ...f, cx: f.cx + i * 0.06 })),
    }))
    judge(record, 'the pattern drifts during the hold instead of standing still',
      'centroid advances a constant 0.06 world units per frame, so it never converges (about 8 units, 56% of the glyph diagonal, over one hold)',
      'checkHold (§3 convergence)', checkHold(drifted, holdSeconds, 'mutant'))
    const stretched = runs.map((w) => ({
      frames: w.frames.map((f) => ({ ...f, t: f.t * (3.5 / 3.0) })),
    }))
    judge(record, 'the hold lasts 3.5 s instead of 3.0 s',
      'the hold run rescaled in time by 3.5/3.0',
      'checkHold (§3 duration)', checkHold(stretched, holdSeconds, 'mutant'))
  }
  judge(record, 'HOLD_SECONDS is 2.5 rather than 3.0',
    'the shipped constant disagrees with the user requirement',
    'checkHold (§3 constant)', checkHold(runs || [], 2.5, 'mutant'))
}

/** Build a summary object from a rotated profile, for the rotated-axis mutant. */
export function rotatedSummary(prof) {
  return profileSummary(prof)
}
