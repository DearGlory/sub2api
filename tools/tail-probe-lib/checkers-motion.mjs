/**
 * §2 (natural transition) and §3 (3 s stationary hold). Both consume the per-frame
 * rows the page recorded: for each frame, the per-particle displacement distribution
 * and the cloud's centroid.
 */
import { TH } from './checkers.mjs'

const row = (name, ok, detail) => ({ name, ok: ok === true, detail: String(detail) })
const fix = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : String(v))

/**
 * §2 — no block flip: the transition must move particles individually, not teleport
 * the whole cloud.
 *
 * Three independent teeth, because each one alone has a hole. P99 catches "many
 * particles jumped"; the per-particle max catches "one particle jumped"; the
 * rigidity index catches "everything moved together", which can be true while every
 * individual step stays small — a rigid translation of a dense cloud has P99 equal to
 * the whole-cloud displacement and an index of exactly 1.0.
 */
export function checkTransition(frames, tag, idleP99) {
  const c = []
  const dTrans = frames.filter((f) => f.p99 !== undefined && (f.phase === 'gather' || f.phase === 'scatter'))
  const gatherN = dTrans.filter((f) => f.phase === 'gather').length
  const scatterN = dTrans.filter((f) => f.phase === 'scatter').length
  if (dTrans.length < 20) {
    c.push(row('gather/scatter frames were captured', false, 'only ' + dTrans.length + ' transition frames measured'))
    return { tag, checks: c, ok: false, metrics: { frames: dTrans.length } }
  }
  const worstP99 = Math.max(...dTrans.map((f) => f.p99))
  const worstMax = Math.max(...dTrans.map((f) => f.max))
  const worstRigid = Math.max(...dTrans.map((f) => f.rigid))
  c.push(row('both transition phases observed with enough frames', gatherN >= 10 && scatterN >= 10,
    'gather frames ' + gatherN + ', scatter frames ' + scatterN))
  c.push(row('P99 per-frame displacement <= ' + TH.transitionP99Max + ' world units',
    worstP99 <= TH.transitionP99Max,
    'worst P99 = ' + fix(worstP99, 4) + ' (travel-phase floor ' +
    (idleP99 === undefined ? 'n/a' : fix(idleP99, 4)) + ')'))
  c.push(row('no single particle jumps more than ' + TH.transitionMaxStepMax + ' units in one frame',
    worstMax <= TH.transitionMaxStepMax, 'worst per-particle step = ' + fix(worstMax, 4)))
  c.push(row('motion is decorrelated, not a rigid block (index <= ' + TH.transitionRigidMax + ')',
    worstRigid <= TH.transitionRigidMax,
    'worst rigid index = ' + fix(worstRigid, 4) + ' (1.0 is a rigid translation)'))
  return {
    tag, checks: c, ok: c.every((x) => x.ok),
    metrics: {
      worstP99: +fix(worstP99, 4), worstMax: +fix(worstMax, 4), worstRigid: +fix(worstRigid, 4),
      gatherFrames: gatherN, scatterFrames: scatterN, idleP99: idleP99 === undefined ? null : +fix(idleP99, 4),
    },
  }
}

/** Split a frame list into runs of consecutive `hold` frames. */
export function holdRuns(frames) {
  const out = []
  let cur = null
  for (const f of frames) {
    if (f.phase === 'hold') {
      if (!cur) cur = []
      cur.push(f)
    } else if (cur) {
      out.push({ frames: cur })
      cur = null
    }
  }
  if (cur) out.push({ frames: cur })
  return out
}

/**
 * §3 — HOLD_SECONDS is 3.0, the hold lasts 3.0 s ± 0.05 s, and the pattern does not
 * travel while it holds.
 *
 * "Does not travel" is tested as convergence rather than total displacement, and the
 * reason is a real measurement, not convenience: the reduced-motion hold's centroid
 * moves 0.8825 units (6.14% of the glyph diagonal) but with per-frame steps decaying
 * from 1.33% to 0.036% of the diagonal — that is the gather's spring settling, which
 * IS stopping, whereas a drift keeps moving at a constant rate (decay ~1.0). Gating
 * on total travel would fail a correct engine; gating on convergence fails the drift
 * by 40x. Both numbers are reported either way.
 */
export function checkHold(runs, holdSeconds, tag) {
  const c = []
  c.push(row('HOLD_SECONDS === 3.0 in the shipped constants', holdSeconds === TH.holdSecondsTarget,
    'HOLD_SECONDS = ' + holdSeconds))
  const full = runs.filter((w) => w.frames.length > 30)
  if (!full.length) {
    c.push(row('a full hold phase was observed', false,
      'hold runs: ' + (runs.length ? runs.map((w) => w.frames.length + 'f').join(',') : 'none')))
    return { tag, checks: c, ok: false, metrics: { runs: runs.length } }
  }
  const m = full.map((w) => {
    const f = w.frames
    const n = f.length
    const span = (f[n - 1].t - f[0].t) / 1000
    const meanDt = f.reduce((a, x) => a + (x.dt || 0), 0) / n / 1000
    const diag = f[n >> 1].diag
    const steps = []
    for (let i = 1; i < n; i++) {
      steps.push(Math.hypot(f[i].cx - f[i - 1].cx, f[i].cy - f[i - 1].cy, f[i].cz - f[i - 1].cz))
    }
    const whole = Math.hypot(f[n - 1].cx - f[0].cx, f[n - 1].cy - f[0].cy, f[n - 1].cz - f[0].cz)
    const half = Math.floor((n - 1) / 2)
    const lastHalf = Math.hypot(
      f[n - 1].cx - f[half].cx, f[n - 1].cy - f[half].cy, f[n - 1].cz - f[half].cz)
    const third = Math.floor(steps.length / 3)
    const meanOf = (a, b) => {
      const s = steps.slice(a, b)
      return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0
    }
    const firstThird = meanOf(0, third)
    const lastThird = meanOf(steps.length - third, steps.length)
    const maxStep = steps.length ? Math.max(...steps) : 0
    return {
      brand: f[0].brand, frames: n, seconds: +fix(span, 3), meanDtMs: +fix(meanDt * 1000, 2),
      diag: +fix(diag, 3), whole: +fix(whole, 4), wholeShare: +fix(whole / diag, 5),
      lastHalfShare: +fix(lastHalf / diag, 5), maxStepShare: +fix(maxStep / diag, 5),
      firstThirdMean: +fix(firstThird, 6), lastThirdMean: +fix(lastThird, 6),
      firstThirdShare: +fix(firstThird / diag, 6), lastThirdShare: +fix(lastThird / diag, 6),
      decay: +fix(firstThird > 0 ? lastThird / firstThird : 1, 4),
      pSpan: +fix(f[n - 1].p - f[0].p, 4), camZdrift: +fix(f[n - 1].camZ - f[0].camZ, 4),
    }
  })
  const worstDur = Math.max(...m.map((x) => Math.abs(x.seconds - TH.holdSecondsTarget)))
  const worstLastHalf = Math.max(...m.map((x) => x.lastHalfShare))
  const worstDecay = Math.max(...m.map((x) => x.decay))
  const tol = TH.holdSecondsTol + Math.max(...m.map((x) => x.meanDtMs)) / 1000
  c.push(row('the hold lasts 3.0 s ± ' + TH.holdSecondsTol + ' s (plus one frame of slack)',
    worstDur <= tol, 'worst |measured - 3.0| = ' + fix(worstDur, 4) + ' s vs tolerance ' + fix(tol, 4) + ' s'))
  c.push(row('the pattern has stopped moving by the end (travel over the last half <= ' +
    (TH.holdLastHalfShareMax * 100) + '% of the diagonal)',
    worstLastHalf <= TH.holdLastHalfShareMax,
    'worst = ' + fix(worstLastHalf * 100, 4) + '% of a ' + m[0].diag + '-unit diagonal' +
    ' (whole-hold travel ' + fix(m[0].wholeShare * 100, 3) + '%, report only)'))
  c.push(row('the motion dies away rather than persisting (last third <= ' +
    TH.holdDecayMax + 'x the first third per frame, where there is motion to decay)',
    m.every((x) => x.firstThirdShare <= TH.holdDecayFloorShare || x.decay <= TH.holdDecayMax),
    'worst decay = ' + fix(worstDecay, 4) + '; first-third step ' + m[0].firstThirdShare * 100 +
    '% of the diagonal vs the ' + (TH.holdDecayFloorShare * 100) +
    '% floor below which the ratio is centroid noise and is not applied' +
    ' (first/last third mean step ' + m[0].firstThirdMean + ' / ' + m[0].lastThirdMean + ' u/frame)'))
  const worstLastThird = Math.max(...m.map((x) => x.lastThirdShare))
  c.push(row('sustained motion at the end of the hold is negligible (last third mean step <= ' +
    (TH.holdLastThirdStepShareMax * 100) + '% of the diagonal per frame)',
    worstLastThird <= TH.holdLastThirdStepShareMax,
    'worst = ' + fix(worstLastThird * 100, 4) + '% of the diagonal per frame' +
    ' (a constant 0.06 u/frame drift measures ' +
    fix(0.06 / m[0].diag * 100, 3) + '%)'))
  c.push(row('no per-frame centroid step exceeds ' + (TH.holdDecayMax * 2 * 100) + '% of the diagonal',
    Math.max(...m.map((x) => x.maxStepShare)) <= TH.holdDecayMax * 2,
    'worst single step = ' + fix(Math.max(...m.map((x) => x.maxStepShare)) * 100, 4) + '%'))
  c.push(row('the hold ran through its whole phase (progress 0 -> 1)',
    m.every((x) => x.pSpan >= 0.98), 'phase progress spans ' + m.map((x) => x.pSpan).join(', ')))
  return { tag, checks: c, ok: c.every((x) => x.ok), metrics: { holds: m } }
}
