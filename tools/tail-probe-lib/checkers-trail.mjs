/**
 * §1b, §1d, §2, §3 verdicts. Split from checkers.mjs only to keep each file's
 * history readable; both are imported through the same barrel.
 */
import { TH } from './checkers.mjs'

const row = (name, ok, detail) => ({ name, ok: ok === true, detail: String(detail) })
const fix = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : String(v))

/**
 * §1b — the position law, i.e. "the particle is EMITTED, not parked on a line".
 *
 * `data.still` comes from a table whose head never moves, so the distance at the end
 * of life IS the particle's own reach. `data.moving` comes from a table whose head
 * moves at constant velocity V along +x, so the closed form for a particle on the
 * ejection axis is |reach + V*life*(1 - TAIL_ENTRAIN)|.
 *
 * Both halves matter. "Born inside the nucleus ball" is what makes it an emission
 * from the comet rather than a slot on a pre-built cone, and it is the one thing a
 * screenshot cannot show.
 */
export function checkReachModel(data, C, tag) {
  const c = []
  const bornMax = Math.max(...data.still.map((x) => x.d0))
  const stillErr = Math.max(...data.still.map((x) => Math.abs(x.dEnd - x.reach)))
  const closedErr = Math.max(...data.moving.map((x) =>
    Math.abs(x.dEnd - Math.abs(x.reach + data.V * x.life * (1 - C.TAIL_ENTRAIN)))))
  const mono = data.moving.filter((x) => x.seq.every((v, i) => i === 0 || v > x.seq[i - 1]))
  const reaches = data.still.map((x) => x.reach)
  const reachSpan = Math.max(...reaches) - Math.min(...reaches)
  c.push(row('age = 0 puts the particle inside the nucleus ball (<= ' + C.HEAD_CORE_RADIUS + ' world units)',
    bornMax <= C.HEAD_CORE_RADIUS + 1e-3,
    'max distance from the head at age 0 = ' + fix(bornMax, 4)))
  c.push(row('age = 0 inside the relaxed ' + TH.birthRadiusMax + '-unit bound the task asked for',
    bornMax <= TH.birthRadiusMax, 'max = ' + fix(bornMax, 4)))
  c.push(row('stationary head: the distance at age == life equals that particle\u2019s own reach',
    stillErr <= TH.reachErrMax, 'max |distance - reach| = ' + fix(stillErr, 6)))
  c.push(row('moving head: the death distance matches |reach + V*life*(1 - TAIL_ENTRAIN)|',
    closedErr <= TH.movingClosedErrMax,
    'max error = ' + fix(closedErr, 6) + ' (V = ' + data.V + ' u/s, TAIL_ENTRAIN = ' + C.TAIL_ENTRAIN + ')'))
  c.push(row('distance from the nucleus increases strictly with age',
    mono.length === data.moving.length, mono.length + '/' + data.moving.length + ' lives monotone'))
  c.push(row('the reach really is per-particle, not one shared length',
    reachSpan >= TH.reachSpanMin,
    'reach spans ' + Math.min(...reaches) + '..' + Math.max(...reaches) +
    ' world units (span ' + fix(reachSpan, 3) + ')'))
  c.push(row('reach values sit inside [TAIL_DUST_REACH_MIN, TAIL_DUST_REACH_MAX]',
    Math.min(...reaches) >= C.TAIL_DUST_REACH_MIN - 1e-6 && Math.max(...reaches) <= C.TAIL_DUST_REACH_MAX + 1e-6,
    'measured ' + Math.min(...reaches) + '..' + Math.max(...reaches) +
    ' vs shipped ' + C.TAIL_DUST_REACH_MIN + '..' + C.TAIL_DUST_REACH_MAX))
  return {
    tag, checks: c, ok: c.every((x) => x.ok),
    metrics: {
      bornMax: +fix(bornMax, 4), stillErrMax: +fix(stillErr, 6), closedFormErrMax: +fix(closedErr, 6),
      monotoneLives: mono.length + '/' + data.moving.length, reachSpan: +fix(reachSpan, 3),
      deathDistances: data.moving.map((x) => +fix(x.dEnd, 3)),
    },
  }
}

/**
 * §1d — the pixel profile. Serves the real frame, the rotated-axis control and the
 * synthetic rigid cone through one code path, so a verdict difference between them
 * can only come from the pixels.
 */
export function checkPixelProfile(sum, tag, optsIn) {
  const opts = optsIn || {}
  const N = sum.excess.length
  const c = []
  /*
   * The tier decides how much of the shape test is MEASURABLE. See the threshold
   * comments: at the minimal tier the plume is only 2–5 luminance units above a sky
   * that is itself 6.4 with structure, so the fine shape tests are reported but not
   * gated, and the loose front-loading bound is applied instead.
   */
  const measurable = sum.peak >= TH.pixelMeasurablePeakExcess
  const peakFloor = TH.pixelPeakExcessMin
  /*
   * `shapeOnly` drops the two gates that ask "is there light here at all" — the absolute light
   * gate and the controls — and keeps the ones that ask "is the light distributed like an
   * emitted tail rather than a rigid cone".
   *
   * Its purpose is the per-moment clause. A single frame from the reduced-motion tier has only
   * 3000 tail particles, and at some moments the plume is genuinely near-invisible: measured
   * peak excess 1.26-1.28 at two of six moments, against a light floor of 3.0. Failing those
   * frames would be failing the tier for being sparse, which is what the tier means. Whether
   * there is light at all is a question the POOLED profile answers, with six frames' worth of
   * samples; whether the shape is right is a question each frame can answer on its own.
   */
  const shapeOnly = opts.shapeOnly === true
  if (!shapeOnly) {
    c.push(row('the plume axis carries real light (peak z >= ' + TH.pixelPeakZMin +
      ', peak excess >= ' + peakFloor + ')',
      sum.peakZ >= TH.pixelPeakZMin && sum.peak >= peakFloor,
      'peak excess ' + fix(sum.peak, 2) + ' at t = ' + fix(sum.peakBin, 0) + 'px (bin ' + sum.peakBin + '/' + N +
      '), z = ' + fix(sum.peakZ, 2) + ', ' + sum.nA[sum.peakBin] + ' taps in the band, ' +
      (measurable ? 'measurable tier' : 'minimal tier (shape tests reported, not gated)')))
  }
  c.push(row('brightest point is near the comet, in the first ' + Math.round(TH.pixelPeakAtMax * 100) + '% of the axis',
    sum.peakAtFrac <= TH.pixelPeakAtMax || !measurable,
    'peak at fraction ' + fix(sum.peakAtFrac, 3) + ' of the axis' +
    (!measurable ? ' (minimal tier: reported only)' : '')))
  const noiseExcused = sum.endSe > 0 &&
    sum.endExcess <= TH.pixelEndNoiseSigma * sum.endSe &&
    (sum.endShare === null || sum.endShare <= TH.pixelEndShareHardMax)
  c.push(row('brightness in the trailing bin <= ' + (TH.pixelEndShareMax * 100) + '% of peak (fades to nothing)',
    sum.peak > 0 && sum.endShare !== null && (!measurable || sum.endShare <= TH.pixelEndShareMax || noiseExcused),
    'end excess ' + fix(sum.endExcess, 2) + ' = ' +
    (sum.endShare === null ? 'n/a' : fix(sum.endShare * 100, 2)) + '% of peak; ' +
    'z at the end bin = ' + fix(sum.endZ, 2) + ', se = ' + fix(sum.endSe, 3) +
    (noiseExcused ? ' -> within ' + TH.pixelEndNoiseSigma + ' sigma of zero, excused as sky noise' : '') +
    (measurable ? '' : ' (minimal tier: reported only)')))
  c.push(row('the far quarter is not flat (no hard-edged cone of constant brightness; <= ' +
    (TH.pixelFarShareMax * 100) + '% of peak)',
    sum.peak > 0 && sum.farShare !== null && sum.farShare <= TH.pixelFarShareMax,
    'mean excess over the last quarter ' + fix(sum.farMean, 2) + ' = ' +
    (sum.farShare === null ? 'n/a' : fix(sum.farShare * 100, 2)) + '% of peak'))
  const tol = Math.max(TH.pixelMonoTolFrac * Math.max(0, sum.peak), 1e-9)
  let viol = 0
  let firstViol = null
  for (let i = sum.peakBin + 1; i < N; i++) {
    // Noise-aware: a rise has to clear BOTH the relative tolerance and three standard
    // errors of the two bins being compared.
    const local = Math.max(tol, TH.pixelMonoSigma * (sum.se[i] + sum.se[i - 1]))
    if (sum.excess[i] > sum.excess[i - 1] + local) {
      viol++
      if (!firstViol) firstViol = 'bin ' + i
    }
  }
  c.push(row('the profile falls monotonically after its peak (<= ' + TH.pixelMonoViolMax + ' rising bin)',
    viol <= TH.pixelMonoViolMax || !measurable,
    'rising bins past the peak: ' + viol + (firstViol ? ' (' + firstViol + ')' : '') +
    ' (tolerance max(' + TH.pixelMonoTolFrac + ' x peak, ' + TH.pixelMonoSigma + ' sigma))' +
    (measurable ? '' : ' (minimal tier: reported only)')))
  c.push(row('the axis was sampled inside the screenshot (no tap off-image)',
    sum.outsideShare <= 1e-9,
    'off-image share ' + fix(sum.outsideShare * 100, 4) + '%; the profile was measured over ' +
    fix(sum.tmaxUsed, 0) + 'px of the axis'))
  if (opts.rotatedPeak !== undefined && opts.rotatedPeak !== null) {
    const share = sum.peak > 0 ? opts.rotatedPeak / sum.peak : 1
    c.push(row('built-in control: the same pixels on an axis rotated 90 deg are dark',
      share <= TH.pixelRotatedShareMax || !measurable,
      'rotated peak ' + fix(opts.rotatedPeak, 2) + ' = ' + fix(share * 100, 1) + '% of the real peak' +
      (!measurable ? ' (low tier: ratio of two noise-level numbers, reported only)' : '')))
  }
  if (!shapeOnly && opts.ctrlBandPeak !== undefined && opts.ctrlBandPeak !== null && sum.perp) {
    /*
     * The parallel-band control. It answers "is the brightness along the tail's axis
     * actually localised to the tail?", which the rotated control cannot: see the note in
     * png.mjs — a 90-degree rotation about the nucleus leaves t = 0 on the coma, so at some
     * moments the rotated band reads BRIGHTER than the tail's own peak (measured 10.0 and
     * 16.6 against real peaks of 5.75 and 15.97).
     *
     * The band is offset from the engine's own reported perpendicular spread, so its
     * stand-off is a measurement rather than a tuned constant.
     */
    const share = sum.peak > 0 ? opts.ctrlBandPeak / sum.peak : 1
    c.push(row('parallel control: the same pixels ' + sum.perp +
      'px off the tail axis are dark (<= ' + (TH.pixelCtrlBandShareMax * 100) + '% of peak)',
      share <= TH.pixelCtrlBandShareMax || !measurable,
      'control-band peak ' + fix(opts.ctrlBandPeak, 2) + ' = ' + fix(share * 100, 1) +
      '% of the real peak, at stand-off ' + sum.perp + 'px' +
      (!measurable ? ' (low tier: ratio of two noise-level numbers, reported only)' : '')))
  }
  if (opts.viewport) {
    const [vw, vh] = opts.viewport
    c.push(row('screenshot pixels equal viewport pixels (no silent rescale)',
      opts.shot && opts.shot[0] === vw && opts.shot[1] === vh,
      'shot ' + (opts.shot ? opts.shot.join('x') : 'n/a') + ' vs viewport ' + vw + 'x' + vh))
  }
  return {
    tag, checks: c, ok: c.every((x) => x.ok),
    metrics: {
      peak: +fix(sum.peak, 2), peakBin: sum.peakBin, peakAtFrac: +fix(sum.peakAtFrac, 3),
      peakZ: +fix(sum.peakZ, 2), endExcess: +fix(sum.endExcess, 2),
      endShare: sum.endShare === null ? null : +fix(sum.endShare, 4),
      farShare: sum.farShare === null ? null : +fix(sum.farShare, 4),
      monoViol: viol, offscreenShare: +fix(sum.outsideShare, 4),
      rotatedPeak: opts.rotatedPeak === undefined ? null : opts.rotatedPeak,
      rotatedShare: opts.rotatedPeak && sum.peak > 0 ? +fix(opts.rotatedPeak / sum.peak, 4) : null,
      profile: sum.excess.map((v) => +fix(v, 2)),
      zProfile: sum.z.map((v) => +fix(v, 2)),
    },
  }
}
